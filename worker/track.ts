import { Hono } from "hono";

export type Bindings = { ANALYTICS: AnalyticsEngineDataset };

/** Events the client may report. Anything else is refused, never stored. */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set(["fonte"]);

/** Hard cap on the request body: a real event is ~60 bytes. */
export const MAX_BODY_BYTES = 2048;

/** Upper bound on a slug's length (mirrors the auth package's bound). */
export const MAX_SLUG_LENGTH = 200;

/**
 * The shape ingest produces: `slugify(title)-fp12`, i.e. lowercase letters and
 * numbers in hyphen-separated runs. Shape only: whether the event exists is
 * not this endpoint's problem.
 */
const SLUG_SHAPE = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;

/**
 * Read the body as text, giving up as soon as it exceeds `limit` bytes so an
 * oversized (or lying `Content-Length`) request is never buffered whole.
 * Returns `null` when over the limit.
 */
async function readCapped(request: Request, limit: number) {
	if (!request.body) return "";

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * `POST /api/track`: a fire-and-forget custom event from the browser's
 * `navigator.sendBeacon`, written to Workers Analytics Engine.
 *
 * Page views are Cloudflare Web Analytics' job; this is only for the few
 * custom events (today `fonte`, a click-out to the event's source).
 *
 * Data point layout (dataset `findleiria_events`, binding `ANALYTICS`); keep
 * it stable, because the order is the schema when querying the SQL API:
 *
 *   index1 = event name              (the sampling key)
 *   blob1  = event name              ("fonte")
 *   blob2  = event slug              (`slugify(title)-fp12`)
 *   blob3  = visitor country         (ISO 3166-1 alpha-2 from `request.cf`,
 *                                     "" when unknown, e.g. local dev)
 *
 * e.g. clicks per source event, last 7 days:
 *   SELECT blob2 AS slug, SUM(_sample_interval) AS clicks
 *   FROM findleiria_events
 *   WHERE blob1 = 'fonte' AND timestamp > NOW() - INTERVAL '7' DAY
 *   GROUP BY slug ORDER BY clicks DESC
 *
 * Refusals: 403 cross-origin or missing `Origin` (sendBeacon always sends it),
 * 413 body over the cap, 400 anything malformed or off the allow-list.
 * Nothing is written for a refused request.
 */
export const trackRoutes = new Hono<{ Bindings: Bindings }>().post(
	"/api/track",
	async (c) => {
		// Same-origin only: the beacon is sent from our own pages.
		const origin = c.req.header("origin");
		if (!origin || origin !== new URL(c.req.url).origin) {
			return c.json({ error: "forbidden_origin" }, 403);
		}

		const declared = Number(c.req.header("content-length"));
		if (declared > MAX_BODY_BYTES) {
			return c.json({ error: "payload_too_large" }, 413);
		}

		const text = await readCapped(c.req.raw, MAX_BODY_BYTES);
		if (text === null) return c.json({ error: "payload_too_large" }, 413);

		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return c.json({ error: "invalid" }, 400);
		}

		const { name, data } = (body ?? {}) as { name?: unknown; data?: unknown };
		if (typeof name !== "string" || !ALLOWED_EVENTS.has(name)) {
			return c.json({ error: "invalid" }, 400);
		}

		const slug = (data as { slug?: unknown } | null | undefined)?.slug;
		if (
			typeof slug !== "string" ||
			slug.length > MAX_SLUG_LENGTH ||
			!SLUG_SHAPE.test(slug)
		) {
			return c.json({ error: "invalid" }, 400);
		}

		const country =
			(c.req.raw as Request & { cf?: { country?: string } }).cf?.country ?? "";

		c.env.ANALYTICS.writeDataPoint({
			blobs: [name, slug, country],
			indexes: [name],
		});

		return c.body(null, 204);
	},
);
