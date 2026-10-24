import { missingAuthEnv } from "@events-tracker/auth/env-check";
import { createMiddleware } from "hono/factory";

/**
 * Fail-closed check in front of the auth and saved-events routes.
 *
 * When a required value is missing at runtime (see `missingAuthEnv`) every
 * request gets the same generic 500, and the missing variable NAMES, never
 * values, are logged once per isolate: a loop of 500s must not flood the log,
 * and the first line is enough to tell what to set. Nothing from the check
 * reaches the response, so a probe learns only that the server is broken.
 *
 * `read` and `log` are injectable for tests; the Worker uses `process.env`
 * (filled from vars and secrets by `nodejs_compat`) and `console.error`.
 */
export function createAuthGuard(
	read: () => Record<string, string | undefined> = () => process.env,
	log: (message: string) => void = (message) => console.error(message),
) {
	let logged = false;

	return createMiddleware(async (c, next) => {
		const missing = missingAuthEnv(read());
		if (missing.length === 0) return next();

		if (!logged) {
			logged = true;
			log(
				`auth disabled, missing or invalid runtime config: ${missing.join(", ")}`,
			);
		}
		return c.json({ error: "server_misconfigured" }, 500);
	});
}
