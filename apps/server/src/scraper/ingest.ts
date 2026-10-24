import { db, schema } from "@events-tracker/db";
import { and, asc, eq, inArray } from "drizzle-orm";

import { canonicalizeCategories } from "./categories";
import type { Conn } from "./conn";
import { errorMessage } from "./errors";
import { deleteEvents } from "./event-delete";
import { fingerprint, fingerprintUndated, lisbonDay } from "./fingerprint";
import { continuesRun, sourceTrust } from "./identity";
import { lastInstant } from "./lifecycle";
import { normalizeVenueName, slugify } from "./normalize";
import { pruneUnlisted, purgePastEvents } from "./purge";
import { reconcileIdentities } from "./reconcile";
import type { RawEvent } from "./types";
import { cityKey, pickVenue, type VenueRow, venueBaseSlug } from "./venue-city";
import { mergeDuplicateVenues } from "./venues";

/**
 * One source's ingest run (C8): the connection every write goes through (the
 * source's transaction) and the venue table, read once and kept current as
 * the run creates and updates venue rows. Nothing else writes venues while a
 * source ingests: the venue merge runs once, after the batch.
 */
interface Writer {
	conn: Conn;
	venues: VenueRow[];
	venueById: Map<number, VenueRow>;
}

async function openWriter(conn: Conn): Promise<Writer> {
	const venues = await conn
		.select({
			id: schema.venues.id,
			name: schema.venues.name,
			city: schema.venues.city,
			slug: schema.venues.slug,
		})
		.from(schema.venues);
	return { conn, venues, venueById: new Map(venues.map((v) => [v.id, v])) };
}

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
	w: Writer,
	venueName: string,
	city: string | null,
): Promise<number> {
	const base = venueBaseSlug(venueName);
	// First pass: the rows sharing this name's slug family (`base`,
	// `base-<town>`…). Only a known town with no same-named row needs every
	// row, to look for a spelling variant in that town.
	const family = w.venues.filter(
		(v) => v.slug === base || v.slug.startsWith(`${base}-`),
	);
	let pick = pickVenue(venueName, city, family);
	if (pick.kind === "create" && cityKey(city) !== "") {
		pick = pickVenue(venueName, city, w.venues);
	}
	if (pick.kind === "use") {
		if (pick.setCity) {
			await w.conn
				.update(schema.venues)
				.set({ city: pick.setCity })
				.where(eq(schema.venues.id, pick.id));
			const cached = w.venueById.get(pick.id);
			if (cached) cached.city = pick.setCity;
		}
		return pick.id;
	}

	const inserted = await w.conn
		.insert(schema.venues)
		.values({ name: pick.name, slug: pick.slug, city: pick.city })
		.onConflictDoNothing({ target: schema.venues.slug })
		.returning({ id: schema.venues.id });
	const id = inserted[0]?.id;
	if (id != null) {
		const row = { id, name: pick.name, city: pick.city, slug: pick.slug };
		w.venues.push(row);
		w.venueById.set(id, row);
		return id;
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

async function eventByFingerprint(
	w: Writer,
	fp: string,
): Promise<EventRow | undefined> {
	return w.conn.query.events.findFirst({
		where: eq(schema.events.fingerprint, fp),
	});
}

async function eventById(w: Writer, id: number): Promise<EventRow | undefined> {
	return w.conn.query.events.findFirst({ where: eq(schema.events.id, id) });
}

/** Town key of the venue an event sits at ("" when unknown or venue-less). */
function townKeyOf(w: Writer, venueId: number | null): string {
	if (venueId == null) return "";
	return cityKey(w.venueById.get(venueId)?.city ?? null);
}

/** True when this source item is the row's FIRST attribution — the raw that minted it. */
async function mintedBy(
	w: Writer,
	eventId: number,
	source: string,
	sourceEventId: string,
): Promise<boolean> {
	const first = await w.conn
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
	w: Writer;
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
	const priorTown = townKeyOf(ctx.w, prior.venue_id);
	const sameTown =
		ctx.town === "" || priorTown === "" || priorTown === ctx.town;
	if (!sameTown) {
		if (!(await mintedBy(ctx.w, prior.id, ctx.source, ctx.raw.slug))) {
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
		!(await eventByFingerprint(ctx.w, ctx.fp))
	) {
		set.fingerprint = ctx.fp;
	}
	if (set.venue_id !== undefined || set.fingerprint !== undefined) {
		await ctx.w.conn
			.update(schema.events)
			.set(set)
			.where(eq(schema.events.id, prior.id));
	}
	return "adopted";
}

/**
 * How the existing row was found. `fingerprint`, `legacy` and `twin` are the
 * raw's OWN occurrence (same title+venue+time, the pre-C3 hash of it, or the
 * same source item on the same day). `alias` and `run` are another day page
 * of a run the row already stands for (C6): the row is extended, never
 * re-timed to that page.
 */
type Match = "fingerprint" | "legacy" | "twin" | "alias" | "run";

/**
 * The keeper an alias resolves this source item to (C6), when that keeper is
 * this occurrence: the same Lisbon day, or a day its run continues into
 * (`continuesRun`, the rule reconcile fuses day pages by). A recurrence of the
 * item weeks later is NOT the keeper — it gets its own row (C4).
 */
async function aliasedRow(
	w: Writer,
	source: string,
	item: string,
	startAt: number,
): Promise<EventRow | undefined> {
	const rows = await w.conn
		.select()
		.from(schema.eventAliases)
		.innerJoin(
			schema.events,
			eq(schema.events.id, schema.eventAliases.event_id),
		)
		.where(
			and(
				eq(schema.eventAliases.source, source),
				eq(schema.eventAliases.source_event_id, item),
			),
		);
	return rows
		.map((r) => r.events)
		.filter(
			(e) =>
				e.date_text == null &&
				(lisbonDay(e.start_at) === lisbonDay(startAt) ||
					continuesRun(e, startAt)),
		)
		.sort((a, b) => a.start_at - b.start_at || a.id - b.id)[0];
}

interface Refresh {
	title: string;
	start_at: number;
	end_at: number | null;
	fingerprint: string;
}

/**
 * C5 — what a re-scrape may rewrite on its own occurrence's row. Only the
 * row's BEST-trust source (ties included) refreshes start/end/title and the
 * fingerprint; a lower-trust source only backfills blanks, so two sources
 * never flip-flop a row between their versions. Returns null when no refresh
 * applies:
 *
 *   - a dated raw only refreshes a dated row, an undated raw an undated one;
 *   - a better-trusted source attributes the row, or another item of this
 *     same source owns it (an alias folded this one in);
 *   - COLLISION: the raw's fingerprint already belongs to another row. The
 *     row is kept as it is (no re-time, no merge here): two rows with the
 *     same fingerprint inputs are the same title/venue/time, which reconcile
 *     fuses on its own pass under its trust rules. Ingest never deletes a
 *     dated row to make room.
 *
 * The end follows the source when it states one; a source that states none
 * keeps the row's end (another source's backfill, or a run reconcile merged).
 * A row that stands for a merged run (it has aliases) only ever grows its end:
 * the first day page's own end must not cut the run short. The slug is never
 * part of a refresh.
 */
async function planRefresh(
	w: Writer,
	row: EventRow,
	raw: RawEvent,
	source: string,
	fp: string,
): Promise<Refresh | null> {
	if ((raw.startAt != null) !== (row.date_text == null)) return null;
	const attributions = await w.conn
		.select({
			source: schema.eventSources.source,
			item: schema.eventSources.source_event_id,
		})
		.from(schema.eventSources)
		.where(eq(schema.eventSources.event_id, row.id));
	const trust = sourceTrust(source);
	for (const a of attributions) {
		if (sourceTrust(a.source) < trust) return null;
		if (a.source === source && a.item !== raw.slug) return null;
	}
	if (row.fingerprint !== fp) {
		const holder = await eventByFingerprint(w, fp);
		if (holder && holder.id !== row.id) return null;
	}
	const start = raw.startAt ?? row.start_at;
	let end = row.end_at;
	if (raw.startAt != null && raw.endAt != null && raw.endAt > start) {
		const mergedRun =
			(
				await w.conn
					.select({ id: schema.eventAliases.id })
					.from(schema.eventAliases)
					.where(eq(schema.eventAliases.event_id, row.id))
					.limit(1)
			).length > 0;
		end =
			mergedRun && row.end_at != null && row.end_at > raw.endAt
				? row.end_at
				: raw.endAt;
	}
	return { title: raw.title, start_at: start, end_at: end, fingerprint: fp };
}

/**
 * Ghost cleanup: an UNDATED twin of this dated raw (same normalized title +
 * venue + town) is superseded by the dated row. Its event_sources rows go
 * with it. A pre-C3 (town-less) undated twin only counts when it sits in this
 * town or an unknown one. `keepId` is the dated row itself, never a ghost.
 */
async function deleteUndatedGhosts(
	w: Writer,
	raw: RawEvent,
	venueRef: string,
	town: string,
	keepId: number,
): Promise<void> {
	const ownGhost = fingerprintUndated(raw.title, venueRef, raw.city);
	const ghosts = await w.conn
		.select({
			id: schema.events.id,
			fingerprint: schema.events.fingerprint,
			city: schema.venues.city,
		})
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(
			inArray(schema.events.fingerprint, [
				ownGhost,
				fingerprintUndated(raw.title, venueRef),
			]),
		);
	await deleteEvents(
		ghosts
			.filter((g) => {
				if (g.id === keepId) return false;
				if (g.fingerprint === ownGhost) return true;
				const key = cityKey(g.city);
				return key === "" || key === town;
			})
			.map((g) => g.id),
		w.conn,
	);
}

/** Upsert a single raw event into events + event_sources. */
async function upsertEvent(
	w: Writer,
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
	const venueId = await resolveOrCreateVenue(w, raw.venueName, raw.city);
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
	const ctx: PriorContext = { w, raw, source, venueId, town, fp, batch };

	let existing = await eventByFingerprint(w, fp);
	let match: Match | null = existing ? "fingerprint" : null;

	// Rows written before the town was hashed carry the town-less fingerprint
	// (an unknown town still hashes that way, so only known towns look). If
	// the row is this raw's, move it onto the new fingerprint — the next
	// normal scrape converges the DB without any repair run.
	if (!existing && town !== "") {
		const legacy = await eventByFingerprint(w, hash(null));
		if (legacy && (await adoptPrior(legacy, ctx, true)) === "adopted") {
			existing = await eventById(w, legacy.id);
			match = "legacy";
		}
	}

	// An item reconcile folded into another row resolves to that keeper (C6).
	if (!existing && raw.slug && raw.startAt != null) {
		existing = await aliasedRow(w, source, raw.slug, raw.startAt);
		if (existing) match = "alias";
	}

	// Same source item, same Lisbon day, different fingerprint: the source
	// re-published this event (retitled, moved venue, shifted the time). That is
	// the SAME occurrence, so reuse its row — a twin minted here is invisible to
	// the identity pass, which only wildcards across venues inside one
	// (title, day) group. An undated raw's twin is the item's undated row. A
	// twin in another town is only reused under adoptPrior's rules.
	//
	// A different day is the same row only when it CONTINUES the row's run
	// (the next day page of a festa, see `continuesRun`): exactly the rows
	// reconcile would fuse, so ingest no longer mints a row for reconcile to
	// absorb again every run (C6). A recurrence further apart (a monthly feira
	// under one slug) stays a separate row (C4).
	let priors: {
		id: number;
		start_at: number;
		end_at: number | null;
		date_text: string | null;
		venue_id: number | null;
		attribution: number;
	}[] = [];
	if (!existing && raw.slug) {
		const startAt = raw.startAt;
		priors = await w.conn
			.select({
				id: schema.events.id,
				start_at: schema.events.start_at,
				end_at: schema.events.end_at,
				date_text: schema.events.date_text,
				venue_id: schema.events.venue_id,
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
			const row = await eventById(w, twin.id);
			if (!row) continue;
			const verdict = await adoptPrior(row, ctx, false);
			if (verdict === "adopted") {
				existing = await eventById(w, twin.id);
				match = "twin";
				break;
			}
			if (verdict === "sibling") continue;
			// Another town's event carrying this item's attribution: a pre-C3
			// fingerprint collision glued it there. It is not that row's
			// source; drop it so the row and this raw's own row stay apart.
			// Never strip a row's last attribution.
			const others = await w.conn
				.select({ id: schema.eventSources.id })
				.from(schema.eventSources)
				.where(eq(schema.eventSources.event_id, twin.id));
			if (others.length > 1) {
				await w.conn
					.delete(schema.eventSources)
					.where(eq(schema.eventSources.id, twin.attribution));
			}
		}
	}

	// The next day page of a run this item's row already stands for.
	if (!existing && raw.slug && raw.startAt != null) {
		const startAt = raw.startAt;
		const runs = priors
			.filter(
				(p) =>
					p.date_text == null &&
					lisbonDay(p.start_at) !== lisbonDay(startAt) &&
					continuesRun(p, startAt),
			)
			.sort((a, b) => a.start_at - b.start_at || a.id - b.id);
		for (const p of runs) {
			// One item, two towns: two occurrences (same rule as adoptPrior).
			const priorTown = townKeyOf(w, p.venue_id);
			if (town !== "" && priorTown !== "" && priorTown !== town) continue;
			existing = await eventById(w, p.id);
			if (existing) {
				match = "run";
				break;
			}
		}
	}

	if (existing) {
		// Cross-source reconciliation: a second source seeing the same event
		// may carry a category the first lacked, or a time the first lacked.
		// Union categories (no data loss), backfill blanks — a lower-trust
		// source never overwrites the best source's values, so re-scrapes
		// converge instead of flip-flopping between sources' fields. The best
		// source itself refreshes its own occurrence (C5, planRefresh).
		const existingCats = (existing.categories ?? []) as string[];
		const mergedCats = [...new Set([...existingCats, ...categories])].sort();
		const mergedUrl = existing.url ?? raw.url;
		let mergedEnd = existing.end_at ?? (raw.startAt != null ? raw.endAt : null);
		let refresh: Refresh | null = null;
		const laterDay =
			raw.startAt != null &&
			lisbonDay(raw.startAt) !== lisbonDay(existing.start_at);
		if ((match === "alias" || match === "run") && laterDay) {
			// Another day page of the run: widen the end the way reconcile's
			// planMerge does for day pages of one item; never re-time the row.
			const pageEnd = raw.endAt ?? raw.startAt ?? existing.start_at;
			mergedEnd =
				pageEnd > (existing.end_at ?? existing.start_at)
					? pageEnd
					: existing.end_at;
		} else if (match !== "alias") {
			// The raw's own occurrence. (An alias on the row's own day is another
			// item folded into it, a second listing of the same show: it only
			// backfills, like any lower-precedence source.)
			refresh = await planRefresh(w, existing, raw, source, fp);
			if (refresh) mergedEnd = refresh.end_at;
		}
		const changed =
			JSON.stringify(existingCats) !== JSON.stringify(mergedCats) ||
			existing.end_at !== mergedEnd ||
			existing.url !== mergedUrl ||
			(refresh != null &&
				(refresh.title !== existing.title ||
					refresh.start_at !== existing.start_at ||
					refresh.fingerprint !== existing.fingerprint));
		if (changed) {
			await w.conn
				.update(schema.events)
				.set({
					categories: mergedCats,
					end_at: mergedEnd,
					url: mergedUrl,
					...(refresh
						? {
								title: refresh.title,
								start_at: refresh.start_at,
								fingerprint: refresh.fingerprint,
							}
						: {}),
					updated_at: now,
				})
				.where(eq(schema.events.id, existing.id));
		}
		if (match === "run" && raw.slug) {
			// The row now stands for a run of this item's day pages. Marking it
			// as a merged run makes its first page's refresh only grow the end.
			await w.conn
				.insert(schema.eventAliases)
				.values({
					source,
					source_event_id: raw.slug,
					event_id: existing.id,
					created_at: now,
				})
				.onConflictDoNothing();
		}
		// The dated row already exists: an undated ghost of it is just as stale
		// as on the insert path.
		if (raw.startAt != null) {
			await deleteUndatedGhosts(w, raw, venueRef, town, existing.id);
		}
		// Always attempt the source-attribution insert: the conflict target is
		// the existence check. Skipping on `unchanged` would break cross-source
		// attribution (source B matching a pre-existing event from source A).
		// On conflict, record that the source still lists the event (C5).
		await w.conn
			.insert(schema.eventSources)
			.values({
				event_id: existing.id,
				source,
				source_event_id: raw.slug,
				source_url: raw.url,
				first_seen_at: now,
				last_seen_at: now,
			})
			.onConflictDoUpdate({
				target: [schema.eventSources.event_id, schema.eventSources.source],
				set: { last_seen_at: now },
			});
		return { action: changed ? "updated" : "unchanged" };
	}

	const fp12 = fp.slice(0, 12);
	const insertedSlug = `${slugify(raw.title) || "evento"}-${fp12}`;
	const inserted = await w.conn
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
		await deleteUndatedGhosts(w, raw, venueRef, town, eventId);
	}
	await w.conn
		.insert(schema.eventSources)
		.values({
			event_id: eventId,
			source,
			source_event_id: raw.slug,
			source_url: raw.url,
			first_seen_at: now,
			last_seen_at: now,
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
	/**
	 * Expired dated rows deleted by the purge. Only `ingest` (which runs the
	 * post-passes) fills it; a batch reports the purge once, not per source.
	 */
	itemsPurged: number;
	/** Rows this full-listing source stopped listing, pruned (C5). */
	itemsPruned: number;
	/** Scrape failures plus raws whose write threw. */
	itemsFailed: number;
	/** Raws whose write threw (the part of itemsFailed ingest itself caused). */
	itemsWriteFailed: number;
	error: string | null;
	/** Non-fatal notes, e.g. the prune circuit breaker refusing (C10). */
	warnings: string | null;
	runId: number | null;
}

export interface ScrapeMeta {
	/** Raw items the scraper saw, including ones it failed to parse/fetch. */
	found: number;
	/** Items dropped before ingest (fetch/parse failures). */
	failures: number;
	/** First scrape-stage error, recorded even if ingest itself succeeded. */
	firstError: string | null;
	/**
	 * The scrape is the source's WHOLE current listing (not an incremental
	 * "new items only" pass), so an item missing from it is gone upstream.
	 * Opt-in: only then may ingest prune unlisted rows (C5). The runner sets
	 * it from the registry's SOURCE_LISTING; manual ingest never does.
	 */
	fullListing?: boolean;
	/** Items the source's listing showed (pre-gate, seen ones included), when it reports it. */
	discovered?: number | null;
	/** Pages the scrape fetched, when the source reports it. */
	pagesFetched?: number | null;
}

const epochNow = () => Math.floor(Date.now() / 1000);

/**
 * Upsert ONE source's raw events and record its `scrape_runs` row, inside a
 * single transaction (C8): one commit instead of a disk sync per statement,
 * and a source whose ingest dies leaves nothing half-written. A raw whose
 * write throws is counted and skipped; the rest of the batch still commits.
 *
 * The per-source prune runs here, on this run's own outcome. The global
 * passes (purge, venue merge, reconcile) do NOT: they run once per batch,
 * see `runPostPasses`. A failed transaction still leaves a run row saying
 * so, then rethrows.
 */
export async function ingestSource(
	rawEvents: RawEvent[],
	source: string,
	meta: ScrapeMeta = { found: rawEvents.length, failures: 0, firstError: null },
): Promise<IngestResult> {
	const startedAt = epochNow();
	const runRow = {
		source,
		started_at: startedAt,
		items_found: meta.found,
		items_discovered: meta.discovered ?? null,
		pages_fetched: meta.pagesFetched ?? null,
	};
	try {
		return await db.transaction(async (tx) => {
			const w = await openWriter(tx);
			let itemsNew = 0;
			let itemsUpdated = 0;
			let itemsSkippedPast = 0;
			let itemsWriteFailed = 0;
			let error = meta.firstError;
			let warnings: string | null = null;
			const towns = batchTowns(rawEvents);

			for (const raw of rawEvents) {
				try {
					const res = await upsertEvent(w, raw, source, towns);
					if (res.action === "inserted") {
						itemsNew++;
					} else if (res.action === "updated") {
						itemsUpdated++;
					} else if (res.action === "skippedPast") {
						itemsSkippedPast++;
					}
				} catch (err) {
					itemsWriteFailed++;
					error ??= errorMessage(err);
				}
			}
			const itemsFailed = meta.failures + itemsWriteFailed;

			// Unlisted-row prune (C5), only after a COMPLETE run of a full-listing
			// source: every item fetched and written, nothing failed, something
			// listed. A partial or broken listing must never delete good events;
			// pruneUnlisted adds per-row guards and a circuit breaker on top.
			let itemsPruned = 0;
			if (
				meta.fullListing === true &&
				meta.failures === 0 &&
				itemsFailed === 0 &&
				error == null &&
				rawEvents.length > 0
			) {
				try {
					const pruned = await pruneUnlisted(source, undefined, tx);
					itemsPruned = pruned.pruned;
					// A refusal is the breaker working, not the run failing (C10).
					warnings = pruned.refused;
				} catch (pruneErr) {
					error = `prune failed: ${errorMessage(pruneErr)}`;
				}
			}

			const run = await tx
				.insert(schema.scrapeRuns)
				.values({
					...runRow,
					finished_at: epochNow(),
					items_new: itemsNew,
					items_updated: itemsUpdated,
					items_pruned: itemsPruned,
					items_failed: itemsFailed,
					error,
					warnings,
				})
				.returning({ id: schema.scrapeRuns.id });

			return {
				itemsFound: meta.found,
				itemsNew,
				itemsUpdated,
				itemsSkippedPast,
				itemsPurged: 0,
				itemsPruned,
				itemsFailed,
				itemsWriteFailed,
				error,
				warnings,
				runId: run[0]?.id ?? null,
			};
		});
	} catch (err) {
		// The transaction rolled back: nothing of this source was written. Leave
		// a run row that says so (best effort), then let the caller see it.
		try {
			await db.insert(schema.scrapeRuns).values({
				...runRow,
				finished_at: epochNow(),
				items_failed: meta.failures + rawEvents.length,
				error: `ingest failed: ${errorMessage(err)}`,
			});
		} catch {
			// The database itself is unwritable; the throw below says enough.
		}
		throw err;
	}
}

/** The batch-wide cleanup passes' outcome (C8, C10). */
export interface PostPassOutcome {
	/** Expired dated rows deleted. */
	purged: number;
	/** Venue rows fused into another. */
	venuesMerged: number;
	/** Identity groups reconcile collapsed. */
	groupsReconciled: number;
	/** One message per pass that threw; empty when all ran. */
	errors: string[];
	/** Wall time per pass, ms. */
	timingsMs: { purge: number; venueMerge: number; reconcile: number };
}

/**
 * The global passes, run ONCE after a batch of sources has ingested (C8)
 * instead of after every source. Each pass is its own transaction and a pass
 * that throws does not stop the next one.
 *
 *   1. purge: the DB only holds today-or-future dated events; whatever
 *      expired since the last batch goes (the ingest guard cannot remove
 *      rows that were valid when first written).
 *   2. venue merge: fuse spelling variants of one venue row, BEFORE…
 *   3. reconcile: collapse rows that are one real-world event hashed apart
 *      (source time disagreements, venue naming), which needs the venue rows
 *      converged first.
 */
export async function runPostPasses(): Promise<PostPassOutcome> {
	const outcome: PostPassOutcome = {
		purged: 0,
		venuesMerged: 0,
		groupsReconciled: 0,
		errors: [],
		timingsMs: { purge: 0, venueMerge: 0, reconcile: 0 },
	};
	const pass = async (
		name: string,
		timing: keyof PostPassOutcome["timingsMs"],
		body: (tx: Conn) => Promise<number>,
	): Promise<number> => {
		const started = Date.now();
		try {
			return await db.transaction(body);
		} catch (err) {
			outcome.errors.push(`${name} failed: ${errorMessage(err)}`);
			return 0;
		} finally {
			outcome.timingsMs[timing] = Date.now() - started;
		}
	};
	outcome.purged = await pass("purge", "purge", (tx) =>
		purgePastEvents(undefined, tx),
	);
	outcome.venuesMerged = await pass("venue merge", "venueMerge", (tx) =>
		mergeDuplicateVenues(tx),
	);
	outcome.groupsReconciled = await pass("reconcile", "reconcile", (tx) =>
		reconcileIdentities(tx),
	);
	return outcome;
}

/**
 * Put the batch's post-pass failures on every run row of the batch (C10), so
 * a broken cleanup is visible next to each source's own outcome instead of
 * hiding behind its first scrape error.
 */
export async function recordPostPasses(
	runIds: readonly number[],
	outcome: PostPassOutcome,
): Promise<void> {
	if (runIds.length === 0 || outcome.errors.length === 0) return;
	await db
		.update(schema.scrapeRuns)
		.set({ postpass_error: outcome.errors.join("; ") })
		.where(inArray(schema.scrapeRuns.id, [...runIds]));
}

/**
 * Ingest one batch on its own: `ingestSource` then the post-passes. For
 * one-off writers (paste-a-link ingest, tests); the scrape batch calls the two
 * halves itself so the passes run once for every source.
 */
export async function ingest(
	rawEvents: RawEvent[],
	source: string,
	meta?: ScrapeMeta,
): Promise<IngestResult> {
	const result = await ingestSource(rawEvents, source, meta);
	const passes = await runPostPasses();
	if (result.runId != null) await recordPostPasses([result.runId], passes);
	return {
		...result,
		itemsPurged: passes.purged,
		error: result.error ?? passes.errors[0] ?? null,
	};
}
