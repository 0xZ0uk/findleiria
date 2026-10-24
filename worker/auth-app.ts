import { authRoutes, savedRoutes } from "@events-tracker/auth";
import { Hono } from "hono";

/**
 * The auth and saved-events routes as one app. Kept in its own module and
 * loaded with a dynamic `import()` from index.ts, because importing
 * `@events-tracker/auth` builds the better-auth instance from the environment
 * on the spot, and that throws when a value such as BETTER_AUTH_URL is
 * missing. Loaded lazily, behind the env check, a misconfigured deploy fails
 * these routes with a clean 500 instead of taking the whole Worker (the static
 * site, /data/*, /api/track) down with an exception at startup.
 */
export const authApp = new Hono()
	.route("/", authRoutes)
	.route("/", savedRoutes);
