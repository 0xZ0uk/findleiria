import { savedRoutes } from "@events-tracker/auth";
import { Hono } from "hono";

/**
 * The reader's saved events, on the same origin as the app.
 *
 * A reader's session cookie is first-party (see `api/auth.ts` for why that
 * matters on Safari). The auth DB's read-write token never leaves this
 * function runtime — the browser only ever talks to `/api/saved`.
 *
 * Env: Vercel injects the project env into `process.env`; nothing is loaded
 * from files here. The build command validated those same values against the
 * `#auth` items of /.env.schema (with NODE_ENV=production) before this
 * deployment existed, and a deployment's env cannot change without a rebuild.
 */
const app = new Hono().route("/", savedRoutes);

export default {
	fetch: (request: Request) => app.fetch(request),
};
