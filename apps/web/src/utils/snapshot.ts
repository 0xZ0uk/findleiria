import {
	EMBEDDED_EVENT_ID,
	type EventDetail,
} from "@events-tracker/api/snapshot-shape";

export { EMBEDDED_EVENT_ID };

/**
 * Browser half of the static snapshot: what used to be SQL filtering.
 *
 * The files are written once a day, so the SQL's `start_at >= today` cannot
 * be baked in: by evening the morning's build is still "today", and the next
 * morning it is yesterday. The snapshot carries a little more than the window
 * on both sides, and the page trims it against its own clock.
 */

/** Rows whose start falls inside `[from, to]`, in their original order. */
export function eventsInWindow<T extends { startAt: number }>(
	events: readonly T[],
	from: number,
	to: number,
): T[] {
	return events.filter((event) => event.startAt >= from && event.startAt <= to);
}

/**
 * The event embedded in this document, if it is the one asked for.
 *
 * The tag survives client-side navigation (the document is never replaced),
 * so it is only trusted for its own slug. A malformed payload is ignored and
 * the page fetches the file instead.
 */
export function readEmbeddedEvent(
	slug: string,
	doc: Pick<Document, "getElementById"> | undefined = typeof document ===
	"undefined"
		? undefined
		: document,
): EventDetail | undefined {
	const text = doc?.getElementById(EMBEDDED_EVENT_ID)?.textContent;
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as EventDetail | null;
		return parsed && parsed.slug === slug ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export class SnapshotError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "SnapshotError";
	}
}

/**
 * GET one snapshot file. `null` on 404 (an event that is gone); anything else
 * that is not JSON is an error, so an SPA fallback page served in place of a
 * missing file can never be read as data.
 */
export async function fetchSnapshotFile<T>(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
	const response = await fetchImpl(url, {
		// The dev server only falls back to index.html for requests that
		// accept HTML, so asking for JSON keeps a missing file a 404 there too.
		headers: { Accept: "application/json" },
	});
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new SnapshotError(
			`Não foi possível carregar os eventos (${response.status}).`,
			response.status,
		);
	}
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("json")) {
		throw new SnapshotError(
			"Os dados da agenda não estão disponíveis.",
			response.status,
		);
	}
	return (await response.json()) as T;
}
