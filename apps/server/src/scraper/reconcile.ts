import { db, schema } from "@events-tracker/db";
import { eq, inArray, isNull, notInArray } from "drizzle-orm";
import { sortCategories } from "./categories";
import type { Conn } from "./conn";
import { deleteEvents } from "./event-delete";
import { fingerprint } from "./fingerprint";
import { planComponents, planMerge } from "./identity";

/**
 * Cross-source identity reconciliation (post-scrape repair pass).
 * Pure rules in identity.ts; this module owns the DB work.
 *
 * Splits dated rows into identity COMPONENTS via planComponents (title+day
 * group, then venue-compatible union-find — RULE 2/3), then within each
 * component the highest-trust tier forms the canonical session set; rows
 * from lower-trust tiers are absorbed into their nearest canonical session
 * within SESSION_WINDOW_SECONDS: categories union, attributions move, keeper
 * times untouched. Idempotent — a converged DB is a no-op.
 *
 * An absorbed row's attribution that cannot move (the keeper already has one
 * from that source) becomes an ALIAS — (source, item) → keeper — instead of
 * being dropped (C6). Ingest resolves aliases, so the item's next scrape
 * lands on the keeper instead of minting a row reconcile must absorb again.
 *
 * Attributions and aliases are read once up front; the moves are decided on
 * that in-memory copy (kept in step with every write) instead of re-querying
 * per absorbed row (C8).
 */
export async function reconcileIdentities(conn: Conn = db): Promise<number> {
	const now = Math.floor(Date.now() / 1000);

	// Aliases of events deleted since (purge, prune, ghost cleanup): the local
	// connection runs with foreign keys off, so the cascade never fires.
	await conn
		.delete(schema.eventAliases)
		.where(
			notInArray(
				schema.eventAliases.event_id,
				conn.select({ id: schema.events.id }).from(schema.events),
			),
		);

	const rows = await conn
		.select({
			id: schema.events.id,
			title: schema.events.title,
			start_at: schema.events.start_at,
			end_at: schema.events.end_at,
			categories: schema.events.categories,
			is_free: schema.events.is_free,
			featured_at: schema.events.featured_at,
			fingerprint: schema.events.fingerprint,
			venue: schema.venues.name,
			city: schema.venues.city,
		})
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(isNull(schema.events.date_text));

	const attributions = await conn
		.select({
			id: schema.eventSources.id,
			event_id: schema.eventSources.event_id,
			source: schema.eventSources.source,
			source_event_id: schema.eventSources.source_event_id,
			last_seen_at: schema.eventSources.last_seen_at,
		})
		.from(schema.eventSources);
	type Attribution = (typeof attributions)[number];
	const sourcesByEvent = new Map<number, string[]>();
	const itemsByEvent = new Map<number, Set<string>>();
	/** Live attribution rows per event, updated as rows move. */
	const attrsByEvent = new Map<number, Attribution[]>();
	for (const a of attributions) {
		const list = sourcesByEvent.get(a.event_id) ?? [];
		list.push(a.source);
		sourcesByEvent.set(a.event_id, list);
		const attrs = attrsByEvent.get(a.event_id) ?? [];
		attrs.push({ ...a });
		attrsByEvent.set(a.event_id, attrs);
		if (a.source_event_id) {
			const items = itemsByEvent.get(a.event_id) ?? new Set<string>();
			items.add(`${a.source}:${a.source_event_id}`);
			itemsByEvent.set(a.event_id, items);
		}
	}
	const aliasesByEvent = new Map<
		number,
		{ source: string; source_event_id: string }[]
	>();
	for (const a of await conn
		.select({
			event_id: schema.eventAliases.event_id,
			source: schema.eventAliases.source,
			source_event_id: schema.eventAliases.source_event_id,
		})
		.from(schema.eventAliases)) {
		const list = aliasesByEvent.get(a.event_id) ?? [];
		list.push({ source: a.source, source_event_id: a.source_event_id });
		aliasesByEvent.set(a.event_id, list);
	}
	/** The one source item owning the row, when exactly one does. */
	const itemKeyOf = (id: number): string | null => {
		const items = itemsByEvent.get(id);
		return items && items.size === 1 ? ([...items][0] ?? null) : null;
	};

	const components = planComponents(
		rows.map((r) => ({ ...r, itemKey: itemKeyOf(r.id) })),
	);

	let merged = 0;
	for (const group of components) {
		if (group.length < 2) continue;
		const fps = new Set(group.map((r) => r.fingerprint));
		if (fps.size < 2) continue; // already one identity (same-day sessions)

		const withSources = group.map((r) => ({
			id: r.id,
			title: r.title,
			start_at: r.start_at,
			end_at: r.end_at,
			itemKey: r.itemKey ?? null,
			sources: sourcesByEvent.get(r.id) ?? [],
		}));
		const plan = planMerge(withSources);
		const keeperIds = new Set(plan.keepers.map((k) => k.id));
		const keepers = group.filter((r) => keeperIds.has(r.id));
		const absorbedRows = group.filter((r) => plan.absorbed.has(r.id));
		if (absorbedRows.length === 0) continue;

		// Union categories across the whole identity group.
		const catSet = new Set<string>();
		for (const r of group) {
			for (const c of (r.categories ?? []) as string[]) catSet.add(c);
		}

		// Move absorbed rows' attributions to their assigned keeper session
		// (nearest in time), then delete the absorbed rows.
		const absorbedByKeeper = new Map<number, number[]>();
		for (const [absorbedId, keeperId] of plan.absorbed) {
			const list = absorbedByKeeper.get(keeperId) ?? [];
			list.push(absorbedId);
			absorbedByKeeper.set(keeperId, list);
		}
		for (const [keeperId, absorbedIds] of absorbedByKeeper) {
			const keeperAttrs = attrsByEvent.get(keeperId) ?? [];
			attrsByEvent.set(keeperId, keeperAttrs);
			const keeperAliases = aliasesByEvent.get(keeperId) ?? [];
			aliasesByEvent.set(keeperId, keeperAliases);
			const moved: number[] = [];
			const dropped: number[] = [];
			for (const absorbedId of absorbedIds) {
				for (const s of attrsByEvent.get(absorbedId) ?? []) {
					const kept = keeperAttrs.find((k) => k.source === s.source);
					if (kept) {
						// One attribution per source per event: the keeper's stays,
						// and the absorbed item survives as an alias so ingest keeps
						// resolving it to the keeper (C6).
						if (s.source_event_id) {
							await conn
								.insert(schema.eventAliases)
								.values({
									source: s.source,
									source_event_id: s.source_event_id,
									event_id: keeperId,
									created_at: now,
								})
								.onConflictDoNothing();
							keeperAliases.push({
								source: s.source,
								source_event_id: s.source_event_id,
							});
						}
						// The item is still listed even if the keeper's own item
						// is not: never let the keeper look staler than it is.
						if (
							s.last_seen_at != null &&
							s.last_seen_at > (kept.last_seen_at ?? 0)
						) {
							await conn
								.update(schema.eventSources)
								.set({ last_seen_at: s.last_seen_at })
								.where(eq(schema.eventSources.id, kept.id));
							kept.last_seen_at = s.last_seen_at;
						}
						dropped.push(s.id);
					} else {
						moved.push(s.id);
						keeperAttrs.push({ ...s, event_id: keeperId });
					}
				}
				attrsByEvent.delete(absorbedId);
				// Aliases already resolving to the absorbed row follow it.
				for (const a of aliasesByEvent.get(absorbedId) ?? []) {
					await conn
						.insert(schema.eventAliases)
						.values({ ...a, event_id: keeperId, created_at: now })
						.onConflictDoNothing();
					keeperAliases.push(a);
				}
				aliasesByEvent.delete(absorbedId);
			}
			if (dropped.length > 0) {
				await conn
					.delete(schema.eventSources)
					.where(inArray(schema.eventSources.id, dropped));
			}
			if (moved.length > 0) {
				await conn
					.update(schema.eventSources)
					.set({ event_id: keeperId })
					.where(inArray(schema.eventSources.id, moved));
			}
			await conn
				.delete(schema.eventAliases)
				.where(inArray(schema.eventAliases.event_id, absorbedIds));
			await deleteEvents(absorbedIds, conn);
		}

		// Keepers: re-fingerprint (identity has converged) and store the
		// unioned categories. Times stay untouched — canonical tier decides —
		// except an end the merge itself implies (day pages of one item).
		for (const k of keepers) {
			const end = plan.endByKeeper?.get(k.id);
			// What the absorbed rows knew that the keeper does not: a known
			// free/paid flag, and a hand-picked week's pick (never lost to a merge).
			const absorbedHere = absorbedRows.filter(
				(r) => plan.absorbed.get(r.id) === k.id,
			);
			const isFree =
				k.is_free == null
					? (absorbedHere.find((r) => r.is_free != null)?.is_free ?? null)
					: null;
			const featuredAt =
				k.featured_at == null
					? (absorbedHere.find((r) => r.featured_at != null)?.featured_at ??
						null)
					: null;
			await conn
				.update(schema.events)
				.set({
					categories: sortCategories(catSet),
					// Town-qualified like ingest's (C3), from the keeper's venue.
					fingerprint: fingerprint(k.title, k.venue ?? "", k.start_at, k.city),
					...(end != null && end !== k.end_at ? { end_at: end } : {}),
					// Only ever fills a blank, so a stale read cannot clear a value.
					...(isFree != null ? { is_free: isFree } : {}),
					...(featuredAt != null ? { featured_at: featuredAt } : {}),
					updated_at: now,
				})
				.where(eq(schema.events.id, k.id));
		}
		merged++;
	}
	return merged;
}

// Standalone execution: bun run src/scraper/reconcile.ts
if (import.meta.main) {
	const n = await reconcileIdentities();
	console.log(JSON.stringify({ mergedGroups: n }));
}
