import { db, schema } from "@events-tracker/db";
import { and, asc, eq, inArray, like, or } from "drizzle-orm";

import { canonicalizeCategories } from "./categories";
import { deleteEvents } from "./event-delete";
import { fingerprint, fingerprintUndated, lisbonDay } from "./fingerprint";
import { lastInstant } from "./lifecycle";
import { normalizeVenueName, slugify } from "./normalize";
import { purgePastEvents } from "./purge";
import { reconcileIdentities } from "./reconcile";
import type { RawEvent } from "./types";
import { cityKey, pickVenue, venueBaseSlug } from "./venue-city";
import { mergeDuplicateVenues } from "./venues";

const VENUE_COLUMNS = {
	id: schema.venues.id,
	name: schema.venues.name,
	city: schema.venues.city,
	slug: schema.venues.slug,
};

/**
 * Resolve or create the venue row for (name, town), returning its stable id.
 * The rules are `pickVenue` (venue-city.ts): a venue is its name AND its town,
 * so "Biblioteca Municipal" in Batalha and in Pombal are two rows (C3); a
 * spelling variant in the same town (`BLACK BOX` vs `Black Box - Plataforma…`)
 * reuses the existing row via the STRICT `venuesMatch`; an unknown town only
 * borrows a row whose name is unambiguous. mergeDuplicateVenues converges any
 * rows this misses.
 */
async function resolveOrCreateVenue(
	venueName: string,
	city: string | null,
): Promise<number> {
	const base = venueBaseSlug(venueName);
	// Cheap first pass: the rows sharing this name's slug family (`base`,
	// `base-<town>`…). Only a known town with no same-named row needs every
	// row, to look for a spelling variant in that town.
	const family = await db
		.select(VENUE_COLUMNS)
		.from(schema.venues)
		.where(
			or(eq(schema.venues.slug, base), like(schema.venues.slug, `${base}-%`)),
		);
	let pick = pickVenue(venueName, city, family);
	if (pick.kind === "create" && cityKey(city) !== "") {
		const all = await db.select(VENUE_COLUMNS).from(schema.venues);
		pick = pickVenue(venueName, city, all);
	}
	if (pick.kind === "use") {
		if (pick.setCity) {
			await db
				.update(schema.venues)
				.set({ city: pick.setCity })
				.where(eq(schema.venues.id, pick.id));
		}
		return pick.id;
	}

	const inserted = await db
		.insert(schema.venues)
		.values({ name: pick.name, slug: pick.slug, city: pick.city })
		.onConflictDoNothing({ target: schema.venues.slug })
		.returning({ id: schema.venues.id });
	if (inserted[0]) {
		return inserted[0].id;
	}
	throw new Error(`Failed to resolve or create venue: ${pick.slug}`);
}

interface EventWrite {
	action: "inserted" | "updated" | "unchanged" | "skippedPast";
}

type EventRow = typeof schema.events.$inferSelect;

/**
 * Towns each source item occupies on each Lisbon day in the current batch
 * (`slug|YYYY-MM-DD` → city keys). A source item listed in TWO towns the same
 * day is two occurrences; neither may take over the other's row.
 */
export type BatchTowns = Map<string, Set<string>>;

function batchKey(slug: string, startAt: number | null): string {
	return `${slug}|${startAt == null ? "UNDATED" : lisbonDay(startAt)}`;
}

export function batchTowns(rawEvents: RawEvent[]): BatchTowns {
	const towns: BatchTowns = new Map();
	for (const raw of rawEvents) {
		if (!raw.slug) continue;
		const k = batchKey(raw.slug, raw.startAt);
		const set = towns.get(k) ?? new Set<string>();
		set.add(cityKey(raw.city));
		towns.set(k, set);
	}
	return towns;
}

async function eventByFingerprint(fp: string): Promise<EventRow | undefined> {
	return db.query.events.findFirst({
		where: eq(schema.events.fingerprint, fp),
	});
}

/** Town key of the venue an event sits at ("" when unknown or venue-less). */
async function townKeyOf(venueId: number | null): Promise<string> {
	if (venueId == null) return "";
	const venue = await db.query.venues.findFirst({
		where: eq(schema.venues.id, venueId),
		columns: { city: true },
	});
	return cityKey(venue?.city ?? null);
}

/** True when this source item is the row's FIRST attribution — the raw that minted it. */
async function mintedBy(
	eventId: number,
	source: string,
	sourceEventId: string,
): Promise<boolean> {
	const first = await db
		.select({
			source: schema.eventSources.source,
			source_event_id: schema.eventSources.source_event_id,
		})
		.from(schema.eventSources)
		.where(eq(schema.eventSources.event_id, eventId))
		.orderBy(
			asc(schema.eventSources.first_seen_at),
			asc(schema.eventSources.id),
		)
		.limit(1);
	return (
		first[0]?.source === source && first[0]?.source_event_id === sourceEventId
	);
}

interface PriorContext {
	raw: RawEvent;
	source: string;
	venueId: number;
	/** The raw's town key ("" = unknown). */
	town: string;
	/** The raw's (town-qualified) fingerprint. */
	fp: string;
	batch: BatchTowns | undefined;
}

/**
 * Decide whether an existing row found by a fallback lookup (the pre-C3
 * town-less fingerprint, or this source item on the same day) is THIS raw's
 * row, and bring it up to date if so.
 *
 * - Same town, or either town unknown: it is ours.
 * - Different known town: it is ours only when this source item minted it
 *   (pre-C3 resolution filed it under the first town that used the venue
 *   name) — otherwise it is another town's event ("foreign") — and no other
 *   raw of this batch lists the item in the row's town (one item, two towns,
 *   same day ⇒ two occurrences: "sibling").
 *
 * Adopting re-points the row at the raw's venue when the town differs and
 * moves it to the raw's fingerprint (`rehash`), when that is still free. The
 * row's SLUG is never touched — saved events and /evento/<slug> stay put.
 */
async function adoptPrior(
	prior: EventRow,
	ctx: PriorContext,
	rehash: boolean,
): Promise<"adopted" | "foreign" | "sibling"> {
	const priorTown = await townKeyOf(prior.venue_id);
	const sameTown =
		ctx.town === "" || priorTown === "" || priorTown === ctx.town;
	if (!sameTown) {
		if (!(await mintedBy(prior.id, ctx.source, ctx.raw.slug))) {
			return "foreign";
		}
		const sibling = ctx.batch
			?.get(batchKey(ctx.raw.slug, ctx.raw.startAt))
			?.has(priorTown);
		if (sibling) return "sibling";
	}
	const set: { venue_id?: number; fingerprint?: string } = {};
	if (ctx.town !== "" && priorTown !== ctx.town) set.venue_id = ctx.venueId;
	if (
		(rehash || set.venue_id !== undefined) &&
		prior.fingerprint !== ctx.fp &&
		!(await eventByFingerprint(ctx.fp))
	) {
		set.fingerprint = ctx.fp;
	}
	if (set.venue_id !== undefined || set.fingerprint !== undefined) {
		await db
			.update(schema.events)
			.set(set)
			.where(eq(schema.events.id, prior.id));
	}
	return "adopted";
}

/** Upsert a single raw event into events + event_sources. */
async function upsertEvent(
	raw: RawEvent,
	source: string,
	batch?: BatchTowns,
): Promise<EventWrite> {
	const now = Math.floor(Date.now() / 1000);
	// Past guard (end-aware, SLICE_7): archive-y sources (CM Leiria RSS serves
	// its full historical agenda; Cister FM lists past festas) emit events
	// whose date is already gone. Skip only when the event has FULLY ENDED —
	// `(endAt ?? startAt) < now`. A past startAt alone must NOT drop an
	// ongoing multi-day festa (Vestiaria 28 Aug–8 Sep, Tremoceira 4–7 Sep) —
	// those are exactly the events users want mid-festa. Never write them:
	// they'd be invisible to queries but bloat the DB and get purged moments
	// later. Skips BEFORE venue resolution so stale raws can't even mint
	// venue rows. An open-ended raw (no endAt) lasts to the end of its
	// Lisbon day — same rule as the purge — so a date-only festa pinned to
	// 00:00 is still ingested all day long.
	const guardAt =
		raw.startAt != null
			? lastInstant(raw.startAt, raw.endAt ?? null)
			: raw.endAt;
	if (guardAt != null && guardAt < now) {
		return { action: "skippedPast" };
	}
	const venueId = await resolveOrCreateVenue(raw.venueName, raw.city);
	// Deterministic venue ref independent of DB state → stable across scrapes.
	const venueRef = slugify(normalizeVenueName(raw.venueName));
	// Canonical taxonomy (SLICE_6): collapse variants, drop platform names.
	// Applied on both write paths; change detection below compares canonical
	// values so re-scrapes converge instead of flip-flopping.
	const categories = canonicalizeCategories(raw.categories);
	// Undated raws hash a literal UNDATED marker so re-scrapes dedupe instead
	// of minting a new fingerprint per ingestion timestamp. The venue's TOWN
	// is part of the hash (C3): same title, same time, same venue NAME in two
	// towns are two events.
	const town = cityKey(raw.city);
	const hash = (city: string | null) =>
		raw.startAt != null
			? fingerprint(raw.title, venueRef, raw.startAt, city)
			: fingerprintUndated(raw.title, venueRef, city);
	const fp = hash(raw.city);
	const ctx: PriorContext = { raw, source, venueId, town, fp, batch };

	let existing = await eventByFingerprint(fp);

	// Rows written before the town was hashed carry the town-less fingerprint
	// (an unknown town still hashes that way, so only known towns look). If
	// the row is this raw's, move it onto the new fingerprint — the next
	// normal scrape converges the DB without any repair run.
	if (!existing && town !== "") {
		const legacy = await eventByFingerprint(hash(null));
		if (legacy && (await adoptPrior(legacy, ctx, true)) === "adopted") {
			existing = await db.query.events.findFirst({
				where: eq(schema.events.id, legacy.id),
			});
		}
	}

	// Same source item, same Lisbon day, different fingerprint: the source
	// re-published this event (retitled, moved venue, shifted the time). That is
	// the SAME occurrence, so reuse its row — a twin minted here is invisible to
	// the identity pass, which only wildcards across venues inside one
	// (title, day) group. A different day stays a separate row on purpose:
	// recurring sources (Região de Leiria, monthly feiras) publish one slug that
	// legitimately covers several occurrences. An undated raw's twin is the
	// item's undated row. A twin in another town is only reused under
	// adoptPrior's rules.
	if (!existing && raw.slug) {
		const startAt = raw.startAt;
		const priors = await db
			.select({
				id: schema.events.id,
				start_at: schema.events.start_at,
				date_text: schema.events.date_text,
				attribution: schema.eventSources.id,
			})
			.from(schema.eventSources)
			.innerJoin(
				schema.events,
				eq(schema.events.id, schema.eventSources.event_id),
			)
			.where(
				and(
					eq(schema.eventSources.source, source),
					eq(schema.eventSources.source_event_id, raw.slug),
				),
			);
		const twins = priors.filter((p) =>
			startAt != null
				? lisbonDay(p.start_at) === lisbonDay(startAt)
				: p.date_text != null,
		);
		for (const twin of twins) {
			const row = await db.query.events.findFirst({
				where: eq(schema.events.id, twin.id),
			});
			if (!row) continue;
			const verdict = await adoptPrior(row, ctx, false);
			if (verdict === "adopted") {
				existing = await db.query.events.findFirst({
					where: eq(schema.events.id, twin.id),
				});
				break;
			}
			if (verdict === "sibling") continue;
			// Another town's event carrying this item's attribution: a pre-C3
			// fingerprint collision glued it there. It is not that row's
			// source; drop it so the row and this raw's own row stay apart.
			// Never strip a row's last attribution.
			const others = await db
				.select({ id: schema.eventSources.id })
				.from(schema.eventSources)
				.where(eq(schema.eventSources.event_id, twin.id));
			if (others.length > 1) {
				await db
					.delete(schema.eventSources)
					.where(eq(schema.eventSources.id, twin.attribution));
			}
		}
	}

	if (existing) {
		// Cross-source reconciliation: a second source seeing the same event
		// may carry a category the first lacked, or a time the first lacked.
		// Union categories (no data loss), backfill blanks — never overwrite
		// the first source's values, so re-scrapes converge instead of
		// flip-flopping between sources' fields.
		const existingCats = (existing.categories ?? []) as string[];
		const mergedCats = [...new Set([...existingCats, ...categories])].sort();
		const mergedEnd =
			existing.end_at ?? (raw.startAt != null ? raw.endAt : null);
		const mergedUrl = existing.url ?? raw.url;
		const changed =
			JSON.stringify(existingCats) !== JSON.stringify(mergedCats) ||
			existing.end_at !== mergedEnd ||
			existing.url !== mergedUrl;
		if (changed) {
			await db
				.update(schema.events)
				.set({
					categories: mergedCats,
					end_at: mergedEnd,
					url: mergedUrl,
					updated_at: now,
				})
				.where(eq(schema.events.id, existing.id));
		}
		// Always attempt the source-attribution insert: onConflictDoNothing is
		// the existence check. Skipping on `unchanged` would break cross-source
		// attribution (source B matching a pre-existing event from source A).
		await db
			.insert(schema.eventSources)
			.values({
				event_id: existing.id,
				source,
				source_event_id: raw.slug,
				source_url: raw.url,
				first_seen_at: now,
			})
			.onConflictDoNothing({
				target: [schema.eventSources.event_id, schema.eventSources.source],
			});
		return { action: changed ? "updated" : "unchanged" };
	}

	const fp12 = fp.slice(0, 12);
	const insertedSlug = `${slugify(raw.title) || "evento"}-${fp12}`;
	const inserted = await db
		.insert(schema.events)
		.values({
			title: raw.title,
			slug: insertedSlug,
			description: raw.description,
			// Undated raws get the ingestion epoch as a calendar placeholder;
			// date_text marks them so views can exclude/flag them.
			start_at: raw.startAt ?? now,
			end_at: raw.endAt,
			venue_id: venueId,
			image_url: raw.imageUrl,
			url: raw.url,
			categories,
			date_text: raw.dateText,
			fingerprint: fp,
			created_at: now,
			updated_at: now,
		})
		.onConflictDoNothing({ target: schema.events.fingerprint })
		.returning({ id: schema.events.id });

	const eventId = inserted[0]?.id;
	if (!eventId) {
		// Concurrent insert won the race — treat as pre-existing.
		return { action: "unchanged" };
	}
	if (raw.startAt != null) {
		// Ghost cleanup: an UNDATED twin of this event (same normalized
		// title + venue + town) is now superseded by the dated row. Its
		// event_sources rows go with it. A pre-C3 (town-less) undated twin
		// only counts when it sits in this town or an unknown one.
		const ghosts = await db
			.select({
				id: schema.events.id,
				fingerprint: schema.events.fingerprint,
				city: schema.venues.city,
			})
			.from(schema.events)
			.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
			.where(
				inArray(schema.events.fingerprint, [
					fingerprintUndated(raw.title, venueRef, raw.city),
					fingerprintUndated(raw.title, venueRef),
				]),
			);
		const ownGhost = fingerprintUndated(raw.title, venueRef, raw.city);
		await deleteEvents(
			ghosts
				.filter((g) => {
					if (g.fingerprint === ownGhost) return true;
					const key = cityKey(g.city);
					return key === "" || key === town;
				})
				.map((g) => g.id),
		);
	}
	await db
		.insert(schema.eventSources)
		.values({
			event_id: eventId,
			source,
			source_event_id: raw.slug,
			source_url: raw.url,
			first_seen_at: now,
		})
		.onConflictDoNothing({
			target: [schema.eventSources.event_id, schema.eventSources.source],
		});
	return { action: "inserted" };
}

export interface IngestResult {
	itemsFound: number;
	itemsNew: number;
	itemsUpdated: number;
	/** Dated raws whose start_at was already past — refused by the guard. */
	itemsSkippedPast: number;
	/** Expired dated rows deleted by the post-scrape purge. */
	itemsPurged: number;
	itemsFailed: number;
	error: string | null;
	runId: number | null;
}

export interface ScrapeMeta {
	/** Raw items the scraper saw, including ones it failed to parse/fetch. */
	found: number;
	/** Items dropped before ingest (fetch/parse failures). */
	failures: number;
	/** First scrape-stage error, recorded even if ingest itself succeeded. */
	firstError: string | null;
}

/** Upsert all raw events and record a scrape_runs row. */
export async function ingest(
	rawEvents: RawEvent[],
	source: string,
	meta: ScrapeMeta = { found: rawEvents.length, failures: 0, firstError: null },
): Promise<IngestResult> {
	const startedAt = Math.floor(Date.now() / 1000);
	let itemsNew = 0;
	let itemsUpdated = 0;
	let itemsSkippedPast = 0;
	let itemsFailed = meta.failures;
	let error = meta.firstError;
	const towns = batchTowns(rawEvents);

	for (const raw of rawEvents) {
		try {
			const res = await upsertEvent(raw, source, towns);
			if (res.action === "inserted") {
				itemsNew++;
			} else if (res.action === "updated") {
				itemsUpdated++;
			} else if (res.action === "skippedPast") {
				itemsSkippedPast++;
			}
		} catch (err) {
			itemsFailed++;
			if (!error) {
				error = err instanceof Error ? err.message : String(err);
			}
		}
	}

	// Post-scrape hygiene: the DB should only hold today-or-future dated
	// events. Anything that expired since the last cycle goes now (guard
	// alone can't remove rows that were valid when first ingested).
	let itemsPurged = 0;
	try {
		itemsPurged = await purgePastEvents();
	} catch (purgeErr) {
		// Never fail the run over cleanup; surface it in the run record.
		const msg = purgeErr instanceof Error ? purgeErr.message : String(purgeErr);
		error = error ?? `purge failed: ${msg}`;
	}

	// Identity reconciliation: collapse rows that are the same real-world
	// event but hashed differently due to source time disagreements (e.g.
	// Viral Agenda's DST-shifted JSON-LD) or venue naming (cross-source).
	// Merges categories + attributions onto the earliest row; no-op on a
	// converged DB. Venue-row fusion must run first so both converge onto
	// one venue_id (and therefore one fingerprint group).
	try {
		await mergeDuplicateVenues();
	} catch (mergeErr) {
		const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
		error = error ?? `venue merge failed: ${msg}`;
	}
	try {
		await reconcileIdentities();
	} catch (recErr) {
		const msg = recErr instanceof Error ? recErr.message : String(recErr);
		error = error ?? `reconcile failed: ${msg}`;
	}

	const finishedAt = Math.floor(Date.now() / 1000);
	const run = await db
		.insert(schema.scrapeRuns)
		.values({
			source,
			started_at: startedAt,
			finished_at: finishedAt,
			items_found: meta.found,
			items_new: itemsNew,
			items_failed: itemsFailed,
			error,
		})
		.returning({ id: schema.scrapeRuns.id });

	return {
		itemsFound: meta.found,
		itemsNew,
		itemsUpdated,
		itemsSkippedPast,
		itemsPurged,
		itemsFailed,
		error,
		runId: run[0]?.id ?? null,
	};
}

export const ingestEvent = upsertEvent;
