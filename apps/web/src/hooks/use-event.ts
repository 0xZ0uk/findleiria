import { useQuery } from "@tanstack/react-query";

import { api } from "@/utils/api";

/**
 * One event by its URL slug.
 *
 * `data` is `null` once the read settles when the slug is unknown, so the
 * page can render a real not-found instead of an empty shell. On a cold load
 * of a prerendered page the event is already in the document, so the first
 * render has data and there is no skeleton and no request. The slug key is
 * part of the query key, so navigating between two events never reuses stale
 * data for the wrong event.
 */
export function useEvent(slug: string) {
	return useQuery(api.event.queryOptions(slug));
}

export type EventModel = NonNullable<ReturnType<typeof useEvent>["data"]>;
