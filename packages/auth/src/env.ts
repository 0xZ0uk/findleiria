/// <reference path="../../../env.d.ts" />

/**
 * Env for the auth runtime only, read from `process.env`.
 *
 * Deliberately separate from `@events-tracker/env/server`: the auth function
 * lives on Vercel and has no business requiring the events `DATABASE_URL` or
 * `CORS_ORIGIN` just to boot. Two databases, two env modules.
 *
 * Nothing is validated here. The rules (required, the 32-char secret, SMTP_*
 * required when NODE_ENV=production, URL shapes) live in the repo-root
 * `.env.schema` under `#auth`, and varlock enforces them before this code runs:
 * locally every script goes through `varlock run`, and on Vercel the build
 * command validates the project env with NODE_ENV=production. A deployment's
 * env cannot change without a new build, so the functions boot on values the
 * build already checked. `process.env` is typed from the schema (`env.d.ts`).
 *
 * What stays here is what the raw environment cannot carry: the schema's
 * defaults (Vercel injects none) and the string-to-number/boolean coercion.
 * Read once at import, as before; empty strings count as unset.
 */
const read = (value: string | undefined) => (value === "" ? undefined : value);

/** varlock's `@type=boolean` spellings of true; the rest it accepts are false. */
const TRUE = new Set(["t", "true", "yes", "on", "1"]);

type NodeEnv = "development" | "production" | "test";

export const authEnv = {
	// Dev/test only: libSQL URL of the auth database (`file:...`), read by
	// auth-db.node.ts under Bun. Production runs on the D1 `AUTH_DB` binding and
	// never reads these two.
	AUTH_DATABASE_URL: read(process.env.AUTH_DATABASE_URL),
	// Only for a remote libSQL AUTH_DATABASE_URL, which is not a production path.
	AUTH_TURSO_TOKEN: read(process.env.AUTH_TURSO_TOKEN),
	// Signs session cookies. Rotating it logs everyone out.
	BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
	// Public origin of the app, used for callback URLs and trusted origins.
	BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
	// Comma-separated extra origins (vercel previews, localhost ports).
	AUTH_TRUSTED_ORIGINS: read(process.env.AUTH_TRUSTED_ORIGINS),
	GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
	// Outgoing mail (email verification). When unset outside production the
	// mailer prints the message instead of sending it.
	SMTP_HOST: read(process.env.SMTP_HOST),
	SMTP_PORT: Number(read(process.env.SMTP_PORT) ?? 587),
	// true = implicit TLS (port 465). false = plain, upgraded by STARTTLS (587).
	SMTP_SECURE: TRUE.has(read(process.env.SMTP_SECURE)?.toLowerCase() ?? ""),
	SMTP_USER: read(process.env.SMTP_USER),
	SMTP_PASS: read(process.env.SMTP_PASS),
	// Sender, e.g. "FindLeiria <no-reply@example.com>".
	SMTP_FROM: read(process.env.SMTP_FROM),
	NODE_ENV: (read(process.env.NODE_ENV) ?? "development") as NodeEnv,
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
