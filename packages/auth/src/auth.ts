import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";

import type { AuthDb } from "./db.js";
import { authDb } from "./db.js";
import { authEnv, getTrustedOrigins } from "./env.js";
import { type Mailer, sendMail } from "./mailer.js";
import { dropStaleUnverifiedUser, googleProvesOwnership } from "./ownership.js";
import * as schema from "./schema.js";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** The verification email, in pt-PT. The link is the whole point. */
export function verificationMessage(to: string, url: string) {
	return {
		to,
		subject: "Confirma o teu email — FindLeiria",
		text: `Olá! Confirma o teu email para entrares no FindLeiria:\n\n${url}\n\nSe não foste tu, ignora esta mensagem.`,
		html: `<p>Olá! Confirma o teu email para entrares no FindLeiria:</p><p><a href="${escapeHtml(url)}">Confirmar email</a></p><p>Se não foste tu, ignora esta mensagem.</p>`,
	};
}

/**
 * The better-auth instance.
 *
 * Two sign-in methods, both needed: Google because most people arrive on a
 * phone where typing is the tax, email/password for the rest. Password accounts
 * must confirm their email before they get a session. Whoever controls an
 * address wins it: Google signing in on an address whose password account is
 * unverified claims it (links, verifies, deletes the password), and an
 * unverified account older than 24h is dropped when the address is used again.
 * See ownership.ts. Verification mail goes through `mailer`, which tests replace.
 */
export function createAuth(
	database: AuthDb = authDb,
	mailer: Mailer = sendMail,
	{
		rateLimit: rateLimitEnabled = authEnv.NODE_ENV === "production",
	}: {
		/** Tests turn it on for one instance; everywhere else it is production-only. */
		rateLimit?: boolean;
	} = {},
) {
	return betterAuth({
		appName: "FindLeiria",
		baseURL: authEnv.BETTER_AUTH_URL,
		secret: authEnv.BETTER_AUTH_SECRET,
		trustedOrigins: getTrustedOrigins(),
		database: drizzleAdapter(database, {
			provider: "sqlite",
			schema,
			// Explicit although it is the default: D1 rejects BEGIN/COMMIT, so a
			// transactional adapter would work on libSQL (tests) and fail in prod.
			transaction: false,
		}),
		emailAndPassword: {
			enabled: true,
			autoSignIn: true,
			minPasswordLength: 8,
			maxPasswordLength: 128,
			// Also stops sign-up from opening a session: none until verified.
			requireEmailVerification: true,
		},
		emailVerification: {
			sendOnSignUp: true,
			// An unverified password account that tries to sign in gets a fresh
			// link, so accounts created before verification need no migration.
			sendOnSignIn: true,
			autoSignInAfterVerification: true,
			sendVerificationEmail: ({ user, url }) =>
				mailer(verificationMessage(user.email, url)),
		},
		socialProviders: {
			google: {
				clientId: authEnv.GOOGLE_CLIENT_ID,
				clientSecret: authEnv.GOOGLE_CLIENT_SECRET,
				// People share phones here; always offer the account picker.
				prompt: "select_account",
			},
		},
		// Phones get opened once a month, not once a day.
		session: {
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			// Signed cookie cache: a page load costs no database round-trip.
			// Tradeoff, kept short on purpose: a revoked session still reads as
			// valid for up to a minute if someone replays the old cookie.
			cookieCache: { enabled: true, maxAge: 60 },
		},
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders: ["google"],
				// Off so that Google can claim an address whose password account never
				// verified. Safe only because `googleProvesOwnership` (below) then
				// refuses anything but a Google-verified, matching email and strips
				// the password accounts before the session exists. See ownership.ts.
				requireLocalEmailVerified: false,
			},
		},
		hooks: { before: dropStaleUnverifiedUser },
		databaseHooks: {
			account: { create: { before: googleProvesOwnership } },
		},
		// Counters in the auth database, not in memory: each serverless instance
		// would otherwise keep its own count, reset on every cold start, so the
		// limit would be close to meaningless. better-auth's special rules stay
		// as shipped (sign-in/sign-up/change-*: 3 per 10s per IP; verification
		// and reset mail: 3 per 60s; everything else 100 per 10s). Off outside
		// production, like better-auth's own default: the suite signs in far
		// faster than 3 per 10s.
		rateLimit: { enabled: rateLimitEnabled, storage: "database" },
		advanced: {
			cookiePrefix: "findleiria",
			// The rate limiter keys on the client address. On Workers that is
			// `CF-Connecting-IP`, which Cloudflare sets and overwrites on every
			// request. `X-Forwarded-For` (better-auth's default) keeps whatever the
			// client put in it (Cloudflare only appends), so trusting its first
			// entry would let anyone pick their own rate-limit key.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
		},
		telemetry: { enabled: false },
	});
}

export const auth = createAuth();
export type Auth = ReturnType<typeof createAuth>;
