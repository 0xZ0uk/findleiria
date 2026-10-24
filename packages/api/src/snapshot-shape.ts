import type {
	eventBySlug,
	eventStats,
	listEvents,
	undatedEvents,
} from "./queries/events";

/**
 * The static snapshot's contract: what the build writes and what the SPA reads.
 *
 * Production has no event API. Once a day the build reads the database through
 * `./queries/events`, writes these files next to the bundle, and the browser
 * fetches them from the CDN. This module holds only types and constants: the
 * web bundle imports it, so it must stay free of drizzle and the db client.
 *
 *   /data/agenda.json         the agenda: dated window + undated + stats
 *   /data/events/<slug>.json  one event with its description, past ones too
 */

/** How far ahead the agenda looks. Wide enough for every date the sources publish. */
export const AGENDA_WINDOW_DAYS = 90;

/**
 * Extra days the snapshot carries beyond the window's far edge.
 *
 * The file is written once a day, and the browser recomputes the window from
 * its own clock, so a reader on day N+1 wants one day the day-N build did not
 * reach. A week of slack also covers a few missed publishes before the far
 * edge starts to thin. It costs about 120 rows a week, sent gzipped.
 */
export const SNAPSHOT_SLACK_DAYS = 7;

/**
 * Days of lookback before the build's own clock. The browser drops whatever
 * started before its own Lisbon midnight; two days cover a 25-hour DST day and
 * a reader whose clock runs behind the build machine's.
 */
export const SNAPSHOT_LOOKBACK_DAYS = 2;

/** Bumped when the file shape changes incompatibly. */
export const SNAPSHOT_VERSION = 1;

/** URL path the files are served under, and their directory inside `dist/`. */
export const SNAPSHOT_DIR = "data";
export const AGENDA_FILE = "agenda.json";

/**
 * The id of the `<script type="application/json">` the prerender puts in each
 * `/evento/<slug>/index.html`, so a cold load paints the event without a fetch.
 */
export const EMBEDDED_EVENT_ID = "findleiria-event";

export function agendaPath(): string {
	return `/${SNAPSHOT_DIR}/${AGENDA_FILE}`;
}

export function eventPath(slug: string): string {
	return `/${SNAPSHOT_DIR}/events/${encodeURIComponent(slug)}.json`;
}

/** One agenda row: same-day sessions merged, no description. */
export type PublicEvent = Awaited<ReturnType<typeof listEvents>>[number];
export type UndatedEvent = Awaited<ReturnType<typeof undatedEvents>>[number];
export type EventStats = Awaited<ReturnType<typeof eventStats>>;
/** One event as stored, with its description. Also the per-event file. */
export type EventDetail = NonNullable<Awaited<ReturnType<typeof eventBySlug>>>;

export type AgendaSnapshot = {
	version: typeof SNAPSHOT_VERSION;
	/** Epoch seconds the build read the database. */
	generatedAt: number;
	/**
	 * The `startAt` range `events` covers. It is wider than the visible window
	 * on both sides; the browser trims it against its own clock.
	 */
	covers: { from: number; to: number };
	/** True when the window query hit its row cap, so later days were dropped. */
	truncated: boolean;
	stats: EventStats;
	/** Dated events, oldest first. */
	events: PublicEvent[];
	/** Announced but undated, newest first. Never mixed into the days. */
	undated: UndatedEvent[];
};
