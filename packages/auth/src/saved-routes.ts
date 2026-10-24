import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { auth } from "./auth.js";
import { getTrustedOrigins } from "./env.js";
import {
	isValidSlug,
	listSavedSlugs,
	MAX_SAVED_PER_USER,
	MAX_SLUG_LENGTH,
	saveEvent,
	unsaveEvent,
} from "./saved.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for the writes, on top of the SameSite=Lax session cookie.
 *
 * A state-changing request must carry an `Origin` the app trusts (the same
 * list better-auth uses) and a JSON body. Browsers attach `Origin` to every
 * cross-origin request and to same-origin POSTs, so a missing one on a write
 * is not a browser: it is refused. Only the safe methods may omit it (a
 * same-origin GET does). Runs before the session lookup, so a forged request
 * learns nothing about whether it was signed in.
 */
const guardWrites = createMiddleware(async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) return next();

	const origin = c.req.header("origin");
	if (!origin || !getTrustedOrigins().includes(origin)) {
		return c.json({ error: "forbidden_origin" }, 403);
	}

	const contentType = c.req.header("content-type") ?? "";
	if (!/^application\/json\s*(;|$)/i.test(contentType)) {
		return c.json({ error: "unsupported_media_type" }, 415);
	}

	return next();
});

/**
 * `GET`/`POST /api/saved` — the reader's saved events, on the same origin as
 * the app so the session cookie is a first-party cookie.
 *
 * Written once and mounted by the Worker and the dev server, exactly like
 * `authRoutes`. The unsave is a `POST` body flag, not a `DELETE` route, so the
 * one path `/api/saved` covers both writes and the Worker needs no per-slug
 * routing.
 */
export const savedRoutes = new Hono()

	.use("/api/saved", guardWrites)

	.get("/api/saved", async (c) => {
		const session = await auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session) return c.json({ error: "unauthorized" }, 401);

		return c.json({ slugs: await listSavedSlugs(session.user.id) });
	})

	.post("/api/saved", async (c) => {
		const session = await auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session) return c.json({ error: "unauthorized" }, 401);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid" }, 400);
		}

		const { slug, saved } = (body ?? {}) as { slug?: unknown; saved?: unknown };

		if (typeof slug !== "string" || typeof saved !== "boolean") {
			return c.json({ error: "invalid" }, 400);
		}

		// Store the slug trimmed so a trailing space never leaves a phantom row.
		const cleanSlug = slug.trim();
		// Saving demands the shape ingest produces. Unsaving only needs a sane
		// bound, so a row saved under an older rule can always be removed.
		const valid = saved
			? isValidSlug(cleanSlug)
			: cleanSlug !== "" && cleanSlug.length <= MAX_SLUG_LENGTH;
		if (!valid) return c.json({ error: "invalid" }, 400);

		if (saved) {
			if ((await saveEvent(session.user.id, cleanSlug)) === "limit") {
				return c.json(
					{ error: "too_many_saved", limit: MAX_SAVED_PER_USER },
					409,
				);
			}
		} else {
			await unsaveEvent(session.user.id, cleanSlug);
		}

		return c.json({ slug: cleanSlug, saved });
	});
