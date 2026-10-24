/**
 * Auth round-trip against a real libSQL file database, through the same Hono
 * handler the Vercel function and the dev server use.
 *
 * The database and its migrations come from the bun preload (test-setup.ts),
 * which also guarantees nothing here can reach a real database or a real SMTP
 * server. Mail goes to an in-memory outbox.
 *
 * The point is the schema: a hand-written Drizzle schema is only correct if
 * better-auth can actually read and write it, so every assertion here walks
 * through the adapter rather than mocking it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createAuth } from "./auth";
import { authDb } from "./db";
import type { MailMessage } from "./mailer";
import { createAuthRoutes } from "./routes";
import { account, session as sessionTable, user } from "./schema";

const ORIGIN = "http://localhost:3300";
const EMAIL = "conta@findleiria.pt";
const PASSWORD = "uma-password-boa-123";

const outbox: MailMessage[] = [];
const routes = createAuthRoutes(
	createAuth(authDb, async (message) => {
		outbox.push(message);
	}),
);

async function request(
	path: string,
	init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
	const { json: body, headers: extra, ...rest } = init;
	const headers: Record<string, string> = {
		origin: ORIGIN,
		...((extra as Record<string, string>) ?? {}),
	};
	if (body !== undefined) headers["content-type"] = "application/json";

	return routes.request(path, {
		method: body === undefined ? "GET" : "POST",
		...rest,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

/** Cookie header for a follow-up request, from a response's Set-Cookie. */
function cookies(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

/** The link out of the plain-text body of a captured email. */
function linkIn(message: MailMessage | undefined): string {
	const link = message?.text.match(/https?:\/\/\S+/)?.[0];
	if (!link) throw new Error("no link in the email");
	return link;
}

const signUp = (email: string, name = "Zé de Leiria") =>
	request("/api/auth/sign-up/email", {
		json: { email, password: PASSWORD, name },
	});

beforeEach(() => {
	outbox.length = 0;
});

describe("email + password", () => {
	let sessionCookie = "";

	test("sign-up emails one verification link and opens no session", async () => {
		const response = await signUp(EMAIL);

		expect(response.status).toBe(200);
		// No session before the address is confirmed.
		expect(response.headers.getSetCookie()).toEqual([]);
		const body = (await response.json()) as {
			token: string | null;
			user: { email: string };
		};
		expect(body.token).toBeNull();
		expect(body.user.email).toBe(EMAIL);

		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.to).toBe(EMAIL);
		expect(outbox[0]?.subject).toBe("Confirma o teu email — FindLeiria");
		expect(linkIn(outbox[0])).toContain("/api/auth/verify-email?token=");
		expect(outbox[0]?.html).toContain("verify-email");

		// The row landed in the schema we wrote, not somewhere better-auth guessed.
		const rows = await authDb.select().from(user).where(eq(user.email, EMAIL));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.emailVerified).toBe(false);
		expect(rows[0]?.createdAt).toBeInstanceOf(Date);
		const sessions = await authDb
			.select()
			.from(sessionTable)
			.where(eq(sessionTable.userId, rows[0]?.id ?? ""));
		expect(sessions).toHaveLength(0);
	});

	test("rejects a password below the minimum", async () => {
		const response = await request("/api/auth/sign-up/email", {
			json: { email: "curta@findleiria.pt", password: "abc", name: "Curta" },
		});

		expect(response.status).toBe(400);
		expect(outbox).toHaveLength(0);
	});

	test("signing up the same email again creates nothing and sends nothing", async () => {
		const response = await signUp(EMAIL, "Outro");

		// Verification on makes the answer generic, so it cannot be used to probe
		// which addresses already have an account.
		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(outbox).toHaveLength(0);
		const rows = await authDb.select().from(user).where(eq(user.email, EMAIL));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Zé de Leiria");
	});

	test("refuses to sign in before the email is verified, and mails a fresh link", async () => {
		const response = await request("/api/auth/sign-in/email", {
			json: { email: EMAIL, password: PASSWORD },
		});

		expect(response.status).toBe(403);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("EMAIL_NOT_VERIFIED");
		expect(response.headers.getSetCookie()).toEqual([]);

		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.to).toBe(EMAIL);
	});

	test("a wrong password is still a 401 and sends no mail", async () => {
		const response = await request("/api/auth/sign-in/email", {
			json: { email: EMAIL, password: "nao-e-esta-123" },
		});

		expect(response.status).toBe(401);
		expect(outbox).toHaveLength(0);
	});

	test("following the link verifies the email and signs the person in", async () => {
		await request("/api/auth/sign-in/email", {
			json: { email: EMAIL, password: PASSWORD },
		});
		expect(outbox).toHaveLength(1);

		const response = await request(linkIn(outbox[0]));

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/");
		sessionCookie = cookies(response);
		expect(sessionCookie).toContain("findleiria.session_token");

		const [row] = await authDb.select().from(user).where(eq(user.email, EMAIL));
		expect(row?.emailVerified).toBe(true);
	});

	test("reads the user back from the session cookie", async () => {
		const response = await request("/api/auth/get-session", {
			headers: { cookie: sessionCookie },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { user: { email: string } };
		expect(body.user.email).toBe(EMAIL);
	});

	test("signs back in with the right password", async () => {
		const response = await request("/api/auth/sign-in/email", {
			json: { email: EMAIL, password: PASSWORD },
		});

		expect(response.status).toBe(200);
		expect(cookies(response)).toContain("findleiria.session_token");
		expect(outbox).toHaveLength(0);
	});

	test("the resend endpoint mails a link for an unverified account only", async () => {
		await signUp("reenviar@findleiria.pt");
		outbox.length = 0;

		const unverified = await request("/api/auth/send-verification-email", {
			json: { email: "reenviar@findleiria.pt", callbackURL: "/entrar" },
		});
		expect(unverified.status).toBe(200);
		expect(outbox).toHaveLength(1);
		expect(linkIn(outbox[0])).toContain("callbackURL=%2Fentrar");

		// Already verified: same answer, no mail.
		outbox.length = 0;
		const verified = await request("/api/auth/send-verification-email", {
			json: { email: EMAIL },
		});
		expect(verified.status).toBe(200);
		expect(outbox).toHaveLength(0);
	});

	test("signs out, clears the cookie and deletes the session", async () => {
		const before = await authDb.select().from(sessionTable);

		const response = await request("/api/auth/sign-out", {
			json: {},
			headers: { cookie: sessionCookie },
		});

		expect(response.status).toBe(200);

		// What the browser sees: the session cookies come back expired.
		const cleared = response.headers.getSetCookie();
		expect(
			cleared.some((cookie) => cookie.startsWith("findleiria.session_token=;")),
		).toBe(true);
		expect(cleared.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);

		// What the database sees: that one session is gone. (A replayed
		// pre-sign-out cookie can still read the session for up to
		// `cookieCache.maxAge` — the documented cost of not hitting the
		// database on every page load.)
		const after = await authDb.select().from(sessionTable);
		expect(after).toHaveLength(before.length - 1);
	});
});

describe("google", () => {
	test("builds the authorize URL with our callback", async () => {
		const response = await request("/api/auth/sign-in/social", {
			json: { provider: "google", callbackURL: `${ORIGIN}/` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { url: string };
		const url = new URL(body.url);

		expect(url.origin + url.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(url.searchParams.get("client_id")).toBe("google-client-id-test");
		expect(url.searchParams.get("redirect_uri")).toBe(
			`${ORIGIN}/api/auth/callback/google`,
		);
		expect(url.searchParams.get("prompt")).toBe("select_account");
		expect(url.searchParams.get("response_type")).toBe("code");
	});
});

/**
 * Account linking, with Google's token endpoint faked. better-auth reads the
 * Google ID token unsigned, so a hand-made one is enough; the only network call
 * (the code-for-token exchange) is intercepted, and any other URL fails the
 * test rather than leaving the machine.
 */
describe("google account linking", () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function fakeGoogle(email: string, sub: string, emailVerified = true) {
		const b64 = (value: object) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const idToken = `${b64({ alg: "none" })}.${b64({
			sub,
			email,
			email_verified: emailVerified,
			name: "Zé Google",
		})}.`;

		globalThis.fetch = (async (input: Request | string | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url !== "https://oauth2.googleapis.com/token") {
				throw new Error(`unexpected network call: ${url}`);
			}
			return Response.json({
				access_token: "access",
				id_token: idToken,
				token_type: "Bearer",
				expires_in: 3600,
			});
		}) as typeof fetch;
	}

	/** Runs the whole redirect dance and returns the callback response. */
	async function signInWithGoogle(
		email: string,
		sub: string,
		emailVerified = true,
	) {
		const start = await request("/api/auth/sign-in/social", {
			json: { provider: "google", callbackURL: `${ORIGIN}/` },
		});
		const { url } = (await start.json()) as { url: string };
		const state = new URL(url).searchParams.get("state");

		fakeGoogle(email, sub, emailVerified);
		return request(`/api/auth/callback/google?code=abc&state=${state}`, {
			headers: { cookie: cookies(start) },
		});
	}

	async function providersOf(email: string) {
		const [row] = await authDb.select().from(user).where(eq(user.email, email));
		const rows = await authDb
			.select()
			.from(account)
			.where(eq(account.userId, row?.id ?? ""));
		return rows.map((a) => a.providerId).sort();
	}

	test("links Google onto a password account once its email is verified", async () => {
		const email = "vinculo@findleiria.pt";
		await signUp(email);
		await request(linkIn(outbox.at(-1)));

		const response = await signInWithGoogle(email, "google-sub-1");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).not.toContain("error");
		expect(cookies(response)).toContain("findleiria.session_token");
		expect(await providersOf(email)).toEqual(["credential", "google"]);
	});

	test("a verified password account keeps its password after Google links", async () => {
		const email = "vinculo@findleiria.pt";

		const password = await request("/api/auth/sign-in/email", {
			json: { email, password: PASSWORD },
		});

		expect(password.status).toBe(200);
		expect(await providersOf(email)).toEqual(["credential", "google"]);
	});

	test("Google claims an address a squatter registered: linked, verified, password gone", async () => {
		const email = "squat@findleiria.pt";
		// The squatter signs up with the owner's address and a password they know.
		await signUp(email);
		const [squatted] = await authDb
			.select()
			.from(user)
			.where(eq(user.email, email));
		expect(squatted?.emailVerified).toBe(false);

		// The owner signs in with Google.
		const response = await signInWithGoogle(email, "google-sub-2");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).not.toContain("error");
		expect(cookies(response)).toContain("findleiria.session_token");

		const [claimed] = await authDb
			.select()
			.from(user)
			.where(eq(user.email, email));
		expect(claimed?.id).toBe(squatted?.id);
		expect(claimed?.emailVerified).toBe(true);
		expect(await providersOf(email)).toEqual(["google"]);

		// The squatter's password no longer works.
		const attempt = await request("/api/auth/sign-in/email", {
			json: { email, password: PASSWORD },
		});
		expect(attempt.status).toBe(401);
		expect(attempt.headers.getSetCookie()).toEqual([]);
	});

	test("refuses to claim an unverified account when Google does not vouch for the email", async () => {
		const email = "nao-verificado@findleiria.pt";
		await signUp(email);

		const response = await signInWithGoogle(email, "google-sub-3", false);

		expect(cookies(response)).not.toContain("findleiria.session_token");
		expect(await providersOf(email)).toEqual(["credential"]);
		const [row] = await authDb.select().from(user).where(eq(user.email, email));
		expect(row?.emailVerified).toBe(false);
	});
});

describe("stale unverified accounts", () => {
	const DAY = 24 * 60 * 60 * 1000;

	async function backdate(email: string, ms: number) {
		await authDb
			.update(user)
			.set({ createdAt: new Date(Date.now() - ms) })
			.where(eq(user.email, email));
	}

	test("a recent unverified account is left alone", async () => {
		const email = "recente@findleiria.pt";
		await signUp(email);
		await backdate(email, DAY - 60 * 60 * 1000);
		outbox.length = 0;

		const again = await signUp(email, "Outra pessoa");

		expect(again.status).toBe(200);
		expect(outbox).toHaveLength(0);
		const rows = await authDb.select().from(user).where(eq(user.email, email));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Zé de Leiria");
	});

	test("sign-up over an unverified account older than 24h replaces it", async () => {
		const email = "velho@findleiria.pt";
		await signUp(email);
		const [old] = await authDb.select().from(user).where(eq(user.email, email));
		await backdate(email, DAY + 60 * 60 * 1000);
		outbox.length = 0;

		const again = await request("/api/auth/sign-up/email", {
			json: { email, password: "outra-password-boa-456", name: "Nova pessoa" },
		});

		expect(again.status).toBe(200);
		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.to).toBe(email);
		const rows = await authDb.select().from(user).where(eq(user.email, email));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).not.toBe(old?.id);
		expect(rows[0]?.name).toBe("Nova pessoa");
		// The old user's accounts went with it.
		const orphans = await authDb
			.select()
			.from(account)
			.where(eq(account.userId, old?.id ?? ""));
		expect(orphans).toHaveLength(0);
	});

	test("a verified account is never dropped, however old", async () => {
		const email = "antigo@findleiria.pt";
		await signUp(email);
		await request(linkIn(outbox.at(-1)));
		await backdate(email, 10 * DAY);
		outbox.length = 0;

		const signUpAgain = await signUp(email, "Intruso");
		const signIn = await request("/api/auth/sign-in/email", {
			json: { email, password: PASSWORD },
		});

		expect(signUpAgain.status).toBe(200);
		expect(outbox).toHaveLength(0);
		expect(signIn.status).toBe(200);
		const rows = await authDb.select().from(user).where(eq(user.email, email));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Zé de Leiria");
		const accounts = await authDb
			.select()
			.from(account)
			.where(eq(account.userId, rows[0]?.id ?? ""));
		expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
	});
});
