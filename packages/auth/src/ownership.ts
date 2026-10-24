import type { BetterAuthOptions, GenericEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

/**
 * Who owns an email address: the two rules that stop a stranger from parking a
 * password on somebody else's address.
 *
 * Without them, anyone could sign up with a friend's email, never verify it,
 * and the friend's Google sign-in would be refused forever (better-auth will
 * not link onto an unverified local account), or worse, the squatter's
 * password would survive on the account once the friend did get in.
 */

/** An unverified password account older than this is abandoned, not pending. */
export const UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000;

const PASSWORD_ENTRY_PATHS = new Set(["/sign-up/email", "/sign-in/email"]);

/**
 * Rule 2, `hooks.before`: on sign-up or sign-in, an existing user with that
 * email who never verified and is older than 24h is deleted (with their
 * accounts and sessions) first, so the request proceeds as if the address were
 * free. Lazy on purpose: no cron, and the row only matters once somebody
 * touches the address. Verified users are never touched.
 */
export const dropStaleUnverifiedUser = createAuthMiddleware(async (ctx) => {
	if (!PASSWORD_ENTRY_PATHS.has(ctx.path)) return;

	const email = (ctx.body as { email?: unknown } | undefined)?.email;
	if (typeof email !== "string") return;

	const { internalAdapter } = ctx.context;
	const found = await internalAdapter.findUserByEmail(email.toLowerCase());
	const stale = found?.user;
	if (!stale || stale.emailVerified) return;
	if (Date.now() - stale.createdAt.getTime() <= UNVERIFIED_TTL_MS) return;

	await internalAdapter.deleteUser(stale.id);
});

/** The claims we need from Google's ID token. */
function googleClaims(idToken: unknown): {
	email?: string;
	email_verified?: boolean;
} | null {
	if (typeof idToken !== "string") return null;
	try {
		const payload = idToken.split(".")[1];
		if (!payload) return null;
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

type AccountHook = NonNullable<
	NonNullable<
		NonNullable<BetterAuthOptions["databaseHooks"]>["account"]
	>["create"]
>["before"];

/**
 * Rule 1, `databaseHooks.account.create.before`: Google has just proven that
 * the person at the keyboard controls the address, so when that address belongs
 * to an UNVERIFIED local user, the Google account is linked, the user is marked
 * verified, and every credential (password) account on the user is deleted, so
 * a squatter's password stops working.
 *
 * This hook is the seam because it runs inside `linkAccount`, in the same
 * OAuth-callback flow and before the callback creates a session; the deletion
 * therefore cannot be skipped between linking and sign-in. It needs
 * `account.accountLinking.requireLocalEmailVerified: false` to be reached at
 * all, which on its own would let any trusted-provider login link onto an
 * unverified account. Hence the checks here: only Google, only when the ID
 * token itself says the email is verified and equals the user's email;
 * otherwise the link is refused (`false`). Verified users are never touched.
 */
export const googleProvesOwnership: AccountHook = async (
	account,
	context: GenericEndpointContext | null,
) => {
	if (account.providerId === "credential") return;
	if (!context) return;

	const { internalAdapter } = context.context;
	const owner = await internalAdapter.findUserById(account.userId);
	if (!owner || owner.emailVerified) return;

	const claims = googleClaims(account.idToken);
	if (
		account.providerId !== "google" ||
		claims?.email_verified !== true ||
		claims.email?.toLowerCase() !== owner.email.toLowerCase()
	) {
		return false;
	}

	const accounts = await internalAdapter.findAccounts(owner.id);
	for (const existing of accounts) {
		if (existing.providerId === "credential") {
			await internalAdapter.deleteAccount(existing.id);
		}
	}
	await internalAdapter.updateUser(owner.id, { emailVerified: true });
};
