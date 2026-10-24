import {
	type AgendaSnapshot,
	agendaPath,
	type EventDetail,
	eventPath,
} from "@events-tracker/api/snapshot-shape";
import {
	keepPreviousData,
	QueryClient,
	queryOptions,
} from "@tanstack/react-query";

import {
	fetchSnapshotFile,
	readEmbeddedEvent,
	SnapshotError,
} from "@/utils/snapshot";

export type {
	EventDetail,
	EventStats,
	PublicEvent,
	UndatedEvent,
} from "@events-tracker/api/snapshot-shape";

/**
 * Read API for the static page.
 *
 * There is no event API in production and no database client in the bundle.
 * The build writes a JSON snapshot next to the SPA (`/data/…`, see
 * `@events-tracker/api/snapshot-shape`) and these read it from the CDN: one
 * file for the whole agenda, one per event. The files change once a day, when
 * the publish triggers a redeploy.
 */

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5 * 60_000,
			// A failed read should admit it quickly rather than retrying for
			// half a minute behind a skeleton.
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
});

/**
 * One row of the reader's saved list. A saved slug is always a single event
 * (the agenda merges a day's sessions into one row; this does not), read from
 * its per-event file, so it is the full detail shape.
 */
export type SavedListEvent = EventDetail;

async function fetchAgenda(): Promise<AgendaSnapshot> {
	const agenda = await fetchSnapshotFile<AgendaSnapshot>(agendaPath());
	if (!agenda) {
		throw new SnapshotError("A agenda ainda não foi publicada.", 404);
	}
	return agenda;
}

/** `null` when the slug has no file: a real not-found, not an empty page. */
function fetchEvent(slug: string): Promise<EventDetail | null> {
	return fetchSnapshotFile<EventDetail>(eventPath(slug));
}

function eventQueryOptions(slug: string) {
	return queryOptions({
		queryKey: ["event", slug],
		queryFn: () => fetchEvent(slug),
		// A prerendered `/evento/<slug>` carries its own event, so a cold load
		// paints the page with no skeleton and no request.
		initialData: () => readEmbeddedEvent(slug),
	});
}

export const api = {
	/**
	 * The whole agenda in one file: dated rows (a little wider than the window,
	 * trimmed by `useAgenda` against the reader's clock), the undated
	 * announcements and the stats behind the fold's last-collection time.
	 */
	agenda: {
		queryOptions: () =>
			queryOptions({
				queryKey: ["agenda", "snapshot"],
				queryFn: fetchAgenda,
			}),
	},
	event: {
		queryOptions: eventQueryOptions,
	},
	/**
	 * The events behind the reader's saved slugs. The list itself is not an
	 * event read: it comes from `/api/saved`, so this is keyed by the slugs it
	 * was handed and stays disabled until there are any.
	 *
	 * Each slug is its own file, read through the event cache, so unsaving one
	 * (a new key) re-reads nothing, and an event page already visited costs no
	 * request. Slugs whose file is gone drop out, which is what lets the page
	 * list them as no longer available.
	 */
	saved: {
		queryOptions: (slugs: string[]) =>
			queryOptions({
				// Own root, apart from the slug list's `["saved-slugs"]`: a prefix
				// cancel or invalidate on one must not catch the other.
				queryKey: ["saved-events", ...slugs],
				queryFn: async () => {
					const events = await Promise.all(
						slugs.map((slug) =>
							queryClient.ensureQueryData(eventQueryOptions(slug)),
						),
					);
					return events
						.filter((event): event is EventDetail => event !== null)
						.sort((a, b) => a.startAt - b.startAt);
				},
				enabled: slugs.length > 0,
				// Each toggle changes the key; without this the list would drop to
				// the skeleton for every unsave.
				placeholderData: keepPreviousData,
			}),
	},
};
