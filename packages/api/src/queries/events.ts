import { type Db, schema } from "@events-tracker/db/client";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { mergeSameDaySessions } from "../grouping";

/**
 * Plain (db, input) query functions — SLICE_8.
 *
 * Two callers run identical SQL through these: the dev-only tRPC router in
 * `../routers/events.ts` (a thin wrapper) and the build-time snapshot in
 * `../snapshot.ts`, which turns their output into the static JSON the SPA
 * reads. No browser code imports this module at runtime; the web app only
 * borrows its types.
 */
export type { Db };

const eventSelect = {
	id: schema.events.id,
	title: schema.events.title,
	slug: schema.events.slug,
	start_at: schema.events.start_at,
	end_at: schema.events.end_at,
	venue_id: schema.events.venue_id,
	image_url: schema.events.image_url,
	url: schema.events.url,
	categories: schema.events.categories,
	date_text: schema.events.date_text,
	venueName: schema.venues.name,
	venueCity: schema.venues.city,
	venueSlug: schema.venues.slug,
	/**
	 * The map's three fields (SLICE_14, Layer 2). Coordinates stay nullable on
	 * purpose: a venue the geocoder could not place inside its own concelho is
	 * refused at the pipeline, so an event here always ships its own honest
	 * location — and a null means "not placeable", which the pins layer reads
	 * rather than guesses around.
	 *
	 * `scope` decides how a place may be drawn: a `concelho` row is the
	 * município's own name and is never a pin, `lugar` is a settlement, `venue`
	 * is a building. ~40 bytes/row on a ~600-row window.
	 */
	venueLat: schema.venues.lat,
	venueLng: schema.venues.lng,
	venueScope: schema.venues.scope,
};

type EventRow = {
	id: number;
	title: string;
	slug: string;
	start_at: number;
	end_at: number | null;
	venue_id: number | null;
	image_url: string | null;
	url: string | null;
	categories: string[] | null;
	date_text: string | null;
	venueName: string | null;
	venueCity: string | null;
	venueSlug: string | null;
	venueLat: number | null;
	venueLng: number | null;
	venueScope: string | null;
};

function toPublicEvent(row: EventRow) {
	return {
		id: row.id,
		title: row.title,
		slug: row.slug,
		startAt: row.start_at,
		endAt: row.end_at,
		venueId: row.venue_id,
		venueName: row.venueName,
		venueCity: row.venueCity,
		venueSlug: row.venueSlug,
		venueLat: row.venueLat,
		venueLng: row.venueLng,
		venueScope: row.venueScope,
		imageUrl: row.image_url,
		url: row.url,
		categories: row.categories ?? [],
		dateText: row.date_text,
	};
}

/**
 * toPublicEvent + same-day session merging: rows that share normalized title,
 * venue, and Lisbon day are sessions of one show (kept separate in the DB on
 * purpose) — list views surface a single entry with `sessionStarts`.
 * Rows must arrive ordered by start_at (they do in every query here).
 */
function toPublicEventList(rows: EventRow[]) {
	return mergeSameDaySessions(rows.map(toPublicEvent));
}

/**
 * Rows returned for a whole agenda window.
 *
 * The 90-day window is already bounded by time, so this is a safety valve, not
 * a page size. It used to be 500, which the live window (492 merged events)
 * was within 8 events of hitting — at which point the furthest-future events
 * drop off the end without any failed request, and only the truncation note
 * hints that they were ever there.
 *
 * 2000 restores headroom without a page loop. Rows carry no `description` (the
 * list renders title/venue/day only), which is measured at ~660B/row: ~325KB
 * for the live window, ~1.3MB if the cap is ever reached. That size is the
 * signal to replace this cap with real paging, not to raise it again.
 */
export const WINDOW_MAX = 2000;

export const listInput = z.object({
	limit: z.number().int().min(1).max(WINDOW_MAX).default(WINDOW_MAX),
	offset: z.number().int().min(0).default(0),
	venueSlug: z.string().optional(),
	category: z.string().optional(),
	dateFrom: z.number().int().optional(),
	dateTo: z.number().int().optional(),
	city: z.string().optional(),
	includeUndated: z.boolean().default(false),
});

export type ListInput = z.infer<typeof listInput>;

export async function listEvents(db: Db, input: ListInput) {
	const conditions = [];
	if (!input.includeUndated) {
		conditions.push(isNull(schema.events.date_text));
	}
	if (input.venueSlug) {
		conditions.push(eq(schema.venues.slug, input.venueSlug));
	}
	if (input.category) {
		conditions.push(
			sql`${schema.events.categories} like ${`%"${input.category}"%`}`,
		);
	}
	if (input.dateFrom !== undefined) {
		conditions.push(gte(schema.events.start_at, input.dateFrom));
	}
	if (input.dateTo !== undefined) {
		conditions.push(lte(schema.events.start_at, input.dateTo));
	}
	if (input.city) {
		conditions.push(eq(schema.venues.city, input.city));
	}

	// Merge BEFORE slicing: LIMIT/OFFSET on raw session rows could split a
	// same-day group across pages (badge-less duplicates, short pages).
	// Volume is small (hundreds), so fetch matching rows unbounded, merge
	// sessions, then apply offset/limit on merged events.
	const rows = await db
		.select(eventSelect)
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(schema.events.start_at);

	const merged = toPublicEventList(rows);
	return merged.slice(input.offset, input.offset + input.limit);
}

export async function eventsByDay(db: Db) {
	const now = Math.floor(Date.now() / 1000);

	const rows = await db
		.select(eventSelect)
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(
			and(gte(schema.events.start_at, now), isNull(schema.events.date_text)),
		)
		.orderBy(schema.events.start_at);

	return toPublicEventList(rows);
}

export async function undatedEvents(db: Db) {
	const rows = await db
		.select(eventSelect)
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(sql`${schema.events.date_text} is not null`)
		.orderBy(desc(schema.events.id));

	return rows.map(toPublicEvent);
}

/**
 * Detail rows carry what the list deliberately drops: the description and the
 * row's update time (used as sitemap `lastmod`, so it must be the row's own
 * timestamp rather than build time).
 */
const eventDetailSelect = {
	...eventSelect,
	description: schema.events.description,
	updated_at: schema.events.updated_at,
};

type EventDetailRow = EventRow & {
	description: string | null;
	updated_at: number;
};

function toPublicEventDetail(row: EventDetailRow) {
	return {
		...toPublicEvent(row),
		description: row.description,
		updatedAt: row.updated_at,
	};
}

/**
 * The saved page's event hydration: every slug a reader saved, resolved to its
 * current row shape in one query.
 *
 * Slugs that no longer resolve simply drop out of the result, so the page can
 * render the leftover ones as muted "já não está disponível" rows with a remove
 * action instead of a blank page. Deliberately no same-day session merging —
 * each saved slug keeps its own identity, unlike the agenda. Empty `slugs`
 * short-circuits to `[]` with no query at all.
 */
export async function eventsBySlugs(db: Db, slugs: string[]) {
	if (slugs.length === 0) return [];

	const rows = await db
		.select(eventSelect)
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(inArray(schema.events.slug, slugs))
		.orderBy(schema.events.start_at);

	return rows.map(toPublicEvent);
}

/**
 * One event by its URL slug — null when the slug is unknown, so callers can
 * render a real not-found instead of an empty page.
 *
 * Returns the row as stored, not the merged view: same-day sessions stay
 * separate rows, and the agenda is where sessions are folded together.
 */
export async function eventBySlug(db: Db, slug: string) {
	const rows = await db
		.select(eventDetailSelect)
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(eq(schema.events.slug, slug))
		.limit(1);

	const row = rows[0];
	return row ? toPublicEventDetail(row) : null;
}

/**
 * Every event, with description, in one query — the input to the build-time
 * prerender step and the sitemap. Deliberately unfiltered and unpaginated:
 * the prerender must cover the whole corpus (a past event still deserves a
 * page), and one query beats 585 lookups.
 */
export async function eventDirectory(db: Db) {
	const rows = await db
		.select(eventDetailSelect)
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.orderBy(desc(schema.events.start_at));

	return rows.map(toPublicEventDetail);
}

export async function venues(db: Db) {
	return db
		.select({
			id: schema.venues.id,
			name: schema.venues.name,
			slug: schema.venues.slug,
			city: schema.venues.city,
		})
		.from(schema.venues)
		.orderBy(schema.venues.name);
}

export async function eventStats(db: Db) {
	const [eventCount, venueCount, latestRun] = await Promise.all([
		db.select({ count: sql<number>`count(*)` }).from(schema.events),
		db.select({ count: sql<number>`count(*)` }).from(schema.venues),
		db
			.select()
			.from(schema.scrapeRuns)
			.orderBy(desc(schema.scrapeRuns.started_at))
			.limit(1),
	]);

	const latest = latestRun[0];

	return {
		totalEvents: Number(eventCount[0]?.count ?? 0),
		totalVenues: Number(venueCount[0]?.count ?? 0),
		lastRunAt: latest?.started_at ?? null,
		lastRunFound: latest?.items_found ?? null,
		lastRunNew: latest?.items_new ?? null,
	};
}
