/**
 * Which of the Worker's required auth values are missing or unusable.
 *
 * On Workers Builds the build and the Worker have separate environments, so the
 * build cannot vouch for the runtime's values (it could on a host where both
 * share one). `wrangler.jsonc` declares the secrets in `secrets.required`,
 * which stops a deploy that lacks them; the plain vars (BETTER_AUTH_URL,
 * MAIL_FROM) have no such guard, so the Worker checks them itself, per
 * request, and fails closed (see worker/auth-guard.ts).
 *
 * Pure on purpose: takes the environment, returns NAMES only. A value never
 * appears in the result, so it is safe to log.
 */

/** Same floor as the `BETTER_AUTH_SECRET` rule in `.env.schema`. */
const MIN_SECRET_LENGTH = 32;

/** Required under the Worker. MAIL_FROM too: the Worker's mail transport throws without it. */
export const REQUIRED_AUTH_ENV = [
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_URL",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"MAIL_FROM",
] as const;

function isUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Names of the required values that are unset, empty, or malformed (a
 * `BETTER_AUTH_SECRET` under 32 characters, a `BETTER_AUTH_URL` that is not a
 * URL). Empty means the Worker may serve auth.
 */
export function missingAuthEnv(
	env: Record<string, string | undefined>,
): string[] {
	return REQUIRED_AUTH_ENV.filter((name) => {
		const value = env[name]?.trim();
		if (!value) return true;
		if (name === "BETTER_AUTH_SECRET") return value.length < MIN_SECRET_LENGTH;
		if (name === "BETTER_AUTH_URL") return !isUrl(value);
		return false;
	});
}
