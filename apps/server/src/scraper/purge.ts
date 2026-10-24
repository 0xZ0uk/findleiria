import { db, schema } from "@events-tracker/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";

import type { Conn } from "./conn";
import { deleteEvents } from "./event-delete";
import { isExpired } from "./lifecycle";

/**
 * Delete every expired dated event. Run once per scrape batch so the DB
 * only ever holds events that are today or in the future (user-visible
 * queries already filter, but the rows shouldn't exist at all — they
 * otherwise accumulate from archive-y sources like CM Leiria's RSS).
 *
 * event_sources rows go with them; venues are kept (registry, not lifecycle).
 */
export async function purgePastEvents(
	now = Math.floor(Date.now() / 1000),
	conn: Conn = db,
): Promise<number> {
	// SQL only narrows to candidates (anything that could be expired has a
	// start or end before now); the real rule lives in isExpired because an
	// open-ended row lasts to the end of its Lisbon day, which SQL can't say.
	const candidates = await conn
		.select({
			id: schema.events.id,
			start_at: schema.events.start_at,
			end_at: schema.events.end_at,
			date_text: schema.events.date_text,
		})
		.from(schema.events)
		.where(
			and(
				isNull(schema.events.date_text),
				or(
					and(isNotNull(schema.events.end_at), lt(schema.events.end_at, now)),
					and(isNull(schema.events.end_at), lt(schema.events.start_at, now)),
				),
			),
		);
	const expired = candidates.filter((e) => isExpired(e, now));
	return deleteEvents(
		expired.map((e) => e.id),
		conn,
	);
}

/**
 * A row a full-listing source has not listed for this long is gone upstream
 * (cancelled, or moved to another date and re-listed as a new item). Three
 * days rides out a source that serves a short or flaky listing for a run or
 * two: a row is only pruned after several consecutive runs without it.
 */
export const UNLISTED_PRUNE_SECONDS = 3 * 86_400;

/**
 * Circuit breaker: a prune that would take more than this share of the
 * source's live rows (and more than PRUNE_FLOOR of them) is refused. A
 * listing that suddenly drops half its events is a broken scrape, not a
 * wave of cancellations.
 */
export const PRUNE_MAX_SHARE = 0.5;
export const PRUNE_FLOOR = 3;

export interface PruneResult {
	pruned: number;
	/** Set when the circuit breaker refused the prune (nothing deleted). */
	refused: string | null;
}

/**
 * Delete rows `source` has stopped listing (C5). The caller (ingest) only
 * calls this after a COMPLETE run of a FULL-listing source — every item
 * fetched, no failures, not an incremental source — and on top of that a row
 * is only pruned when ALL of these hold:
 *
 *   - its only attribution (and alias) is this source: another source still
 *     vouching for the event keeps it;
 *   - it is a future event (start after `now`) or undated — ongoing and past
 *     rows are the date purge's business;
 *   - this source last listed it at least UNLISTED_PRUNE_SECONDS ago (a null
 *     last_seen_at — never tracked — is never pruned);
 *   - the prune stays under the PRUNE_MAX_SHARE circuit breaker.
 */
export async function pruneUnlisted(
	source: string,
	now = Math.floor(Date.now() / 1000),
	conn: Conn = db,
): Promise<PruneResult> {
	const live = or(
		isNotNull(schema.events.date_text),
		gt(schema.events.start_at, now),
	);
	const owned = await conn
		.select({
			id: schema.events.id,
			last_seen_at: schema.eventSources.last_seen_at,
		})
		.from(schema.eventSources)
		.innerJoin(
			schema.events,
			eq(schema.events.id, schema.eventSources.event_id),
		)
		.where(and(eq(schema.eventSources.source, source), live));
	const stale = owned
		.filter(
			(r) =>
				r.last_seen_at != null &&
				r.last_seen_at <= now - UNLISTED_PRUNE_SECONDS,
		)
		.map((r) => r.id);
	if (stale.length === 0) return { pruned: 0, refused: null };

	// Anything another source vouches for stays.
	const vouched = new Set<number>();
	for (const a of await conn
		.select({
			event_id: schema.eventSources.event_id,
			source: schema.eventSources.source,
		})
		.from(schema.eventSources)
		.where(inArray(schema.eventSources.event_id, stale))) {
		if (a.source !== source) vouched.add(a.event_id);
	}
	for (const a of await conn
		.select({
			event_id: schema.eventAliases.event_id,
			source: schema.eventAliases.source,
		})
		.from(schema.eventAliases)
		.where(inArray(schema.eventAliases.event_id, stale))) {
		if (a.source !== source) vouched.add(a.event_id);
	}
	const doomed = stale.filter((id) => !vouched.has(id));
	if (doomed.length === 0) return { pruned: 0, refused: null };

	if (
		doomed.length > PRUNE_FLOOR &&
		doomed.length > owned.length * PRUNE_MAX_SHARE
	) {
		return {
			pruned: 0,
			refused: `prune refused: ${doomed.length} of ${owned.length} live ${source} rows unlisted for ${UNLISTED_PRUNE_SECONDS / 86_400}+ days`,
		};
	}
	return { pruned: await deleteEvents(doomed, conn), refused: null };
}

// Standalone execution: bun run src/scraper/purge.ts
if (import.meta.main) {
	const n = await purgePastEvents();
	console.log(JSON.stringify({ purged: n }));
}
