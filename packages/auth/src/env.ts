import type { EnvSchemaAsStrings } from "../../../env";

/**
 * Env for the auth runtime only, read from `process.env`.
 *
 * Deliberately separate from `@events-tracker/env/server`: the Worker's auth
 * routes have no business requiring the events `DATABASE_URL` or `CORS_ORIGIN`
 * just to boot. Two databases, two env modules.
 *
 * Nothing is validated here. The rules (required, the 32-char secret, URL
 * shapes) live in the repo-root `.env.schema` under `#auth`. Locally varlock
 * enforces them before this code runs: every script goes through
 * `varlock run`. In the Worker nothing validates at build time (the build and
 * the Worker have separate environments), so the secrets are declared in
 * `secrets.required` (wrangler.jsonc) and the Worker re-checks every value per
 * request (`missingAuthEnv`, env-check.ts; worker/auth-guard.ts). Under
 * `nodejs_compat` the Worker's vars and secrets are on `process.env`.
 * The values are typed from the schema (`env.d.ts`) through `schemaEnv`:
 * wrangler's types already declare `NodeJS.ProcessEnv`, so varlock leaves it
 * alone.
 *
 * What stays here is what the raw environment cannot carry: the string-to-
 * number/boolean coercion and the "empty means unset" rule. Read once at
 * import, as before.
 */
const schemaEnv = process.env as unknown as EnvSchemaAsStrings;

const read = (value: string | undefined) => (value === "" ? undefined : value);

type NodeEnv = "development" | "production" | "test";

export const authEnv = {
	// Dev/test only: `file:` URL of the auth database (a SQLite file), read by
	// auth-db.node.ts under Bun. Production runs on the D1 `AUTH_DB` binding and
	// never reads it.
	AUTH_DATABASE_URL: read(schemaEnv.AUTH_DATABASE_URL),
	// Signs session cookies. Rotating it logs everyone out.
	BETTER_AUTH_SECRET: schemaEnv.BETTER_AUTH_SECRET,
	// Public origin of the app, used for callback URLs and trusted origins.
	BETTER_AUTH_URL: schemaEnv.BETTER_AUTH_URL,
	// Comma-separated extra origins (preview deployments, localhost ports).
	AUTH_TRUSTED_ORIGINS: read(schemaEnv.AUTH_TRUSTED_ORIGINS),
	GOOGLE_CLIENT_ID: schemaEnv.GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET: schemaEnv.GOOGLE_CLIENT_SECRET,
	// Sender of the verification mail, e.g. "FindLeiria <no-reply@findleiria.pt>",
	// on a domain onboarded to Cloudflare Email Sending. Only the Worker's mail
	// transport reads it; the local one just prints the message.
	MAIL_FROM: read(schemaEnv.MAIL_FROM),
	NODE_ENV: (read(schemaEnv.NODE_ENV) ?? "development") as NodeEnv,
};

/**
 * Loopback spellings of the public origin, added in development only.
 *
 * `localhost` and `127.0.0.1` are the same machine but not the same origin, so
 * a dev server bound to one and a browser that typed the other ends in a 403
 * `INVALID_ORIGIN` that looks like a broken sign-in. Only ever added outside
 * production: on a real host an unexpected origin is a real attack.
 */
function developmentLoopbackAliases(): string[] {
	if (authEnv.NODE_ENV === "production") return [];

	const { protocol, port } = new URL(authEnv.BETTER_AUTH_URL);
	const suffix = port ? `:${port}` : "";

	return ["localhost", "127.0.0.1", "[::1]"].map(
		(host) => `${protocol}//${host}${suffix}`,
	);
}

/** Every origin the browser may send auth requests from. */
export function getTrustedOrigins(): string[] {
	const extra = (authEnv.AUTH_TRUSTED_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

	return [
		...new Set([
			authEnv.BETTER_AUTH_URL,
			...developmentLoopbackAliases(),
			...extra,
		]),
	];
}
