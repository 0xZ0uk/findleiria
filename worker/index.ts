import { authRoutes, savedRoutes } from "@events-tracker/auth";
import { Hono } from "hono";

import { trackRoutes } from "./track";

/**
 * The whole site's entry point: the API plus static-asset fallthrough.
 *
 * wrangler.jsonc sends only `/api/*` and `/data/*` here
 * (`assets.run_worker_first`); every other path is answered by the assets
 * layer directly (the SPA shell, prerendered `/evento/<slug>` pages, `/og/*`).
 * The routes are the same sub-apps the Bun dev server mounts, so both exercise
 * the same handlers.
 *
 * Env: Cloudflare vars and secrets are exposed on `process.env` (nodejs_compat),
 * which is where `authEnv` reads them.
 */
const app = new Hono<{ Bindings: Env }>();

app.route("/", authRoutes);
app.route("/", savedRoutes);

// Custom analytics events (Workers Analytics Engine); see track.ts.
app.route("/", trackRoutes);

// The snapshot lives in the assets, but the assets layer answers any missing
// path with the SPA shell (a 200 of HTML). A reader's `fetch("/data/...")`
// would then try to parse HTML as JSON, so a miss must be a real 404.
app.on(["GET", "HEAD"], "/data/*", async (c) => {
	const response = await c.env.ASSETS.fetch(c.req.raw);
	if (response.headers.get("Content-Type")?.startsWith("text/html")) {
		return c.text("Not found", 404);
	}
	return response;
});

// An unknown /api path is a real 404 (never the SPA shell); anything else
// that reaches the Worker is handed to the assets layer.
app.notFound((c) => {
	if (new URL(c.req.url).pathname.startsWith("/api/")) {
		return c.json({ error: "Not found" }, 404);
	}
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
