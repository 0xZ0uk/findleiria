import { authRoutes } from "@events-tracker/auth";
import { Hono } from "hono";

/**
 * Every auth endpoint, on the same origin as the app.
 *
 * Same origin is not a preference: cookies from a separate API domain are
 * third-party cookies, which Safari refuses — and most people here arrive on an
 * iPhone. Vercel's Node.js runtime accepts a Web-standard `fetch` export, so no
 * adapter is needed.
 *
 * Env: Vercel injects the project env into `process.env`; nothing is loaded
 * from files here. The build command validated those same values against the
 * `#auth` items of /.env.schema (with NODE_ENV=production) before this
 * deployment existed, and a deployment's env cannot change without a rebuild.
 */
const app = new Hono().route("/", authRoutes);

export default {
	fetch: (request: Request) => app.fetch(request),
};
