/** Built once: constructing an `Intl.DateTimeFormat` costs far more than `format`. */
const LISBON_DAY = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Europe/Lisbon",
});

/**
 * Lisbon-local day of an epoch-seconds instant, `YYYY-MM-DD`.
 * Mirrors the scraper's `lisbonDay` (apps/server/src/scraper/fingerprint.ts)
 * and the web app's `dayKey` — via Intl so the API layer stays dependency-free.
 */
export function lisbonDayKey(epochSeconds: number): string {
	return LISBON_DAY.format(new Date(epochSeconds * 1000));
}

/** Lowercase + strip diacritics + collapse non-alphanumerics (match key only). */
export function normalizeEventTitle(title: string): string {
	return title
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // combining diacritical marks
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Minimal shape of an event row needed for same-day session merging. */
export interface MergeableEvent {
	title: string;
	venueId: number | null;
	startAt: number;
	endAt: number | null;
	/** Optional: when present, a later session's known value fills the merged row's blank. */
	isFree?: boolean | null;
	featuredAt?: number | null;
}

/**
 * Merge same-day sessions of the same show into one row.
 *
 * Two rows that share a normalized title, venue, and Lisbon-local day are
 * distinct *sessions* of one event (e.g. a 18h30 and 21h30 screening) — the
 * fingerprint pipeline keeps them separate on purpose (one VEVENT per session
 * in ICS), but list/calendar views should show a single entry.
 *
 * Returns the earliest row of each group, augmented with `sessionStarts`:
 * the sorted, deduped epoch seconds of every session (earliest included).
 * Groups containing a single row still get `sessionStarts: [start_at]` so
 * consumers never branch on the field. Input order is preserved (rows arrive
 * ordered by start_at; merged rows surface at their first session's slot).
 */
export function mergeSameDaySessions<T extends MergeableEvent>(
	rows: T[],
): (T & { sessionStarts: number[] })[] {
	const out: (T & { sessionStarts: number[] })[] = [];
	const groups = new Map<
		string,
		{ row: T & { sessionStarts: number[] }; starts: number[] }
	>();

	for (const row of rows) {
		const key = `${normalizeEventTitle(row.title)}|${
			row.venueId ?? "none"
		}|${lisbonDayKey(row.startAt)}`;
		const group = groups.get(key);
		if (!group) {
			const merged = { ...row, sessionStarts: [row.startAt] };
			groups.set(key, { row: merged, starts: [row.startAt] });
			out.push(merged);
		} else {
			group.starts.push(row.startAt);
			// A free/paid flag or a pick on a later session belongs to the show.
			if (group.row.isFree == null && row.isFree != null) {
				group.row.isFree = row.isFree;
			}
			if (group.row.featuredAt == null && row.featuredAt != null) {
				group.row.featuredAt = row.featuredAt;
			}
			group.row.sessionStarts = [...new Set(group.starts)].sort(
				(a, b) => a - b,
			);
			// The merged row always represents the earliest session, even if
			// the input arrived unordered (production input is start-ordered).
			group.row.startAt = group.row.sessionStarts[0] ?? group.row.startAt;
		}
	}

	return out;
}
