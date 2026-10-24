import { db, schema } from "@events-tracker/db";
import { count, eq, inArray } from "drizzle-orm";

import type { Conn } from "./conn";
import {
	isVagueVenue,
	normalizeTitle,
	normalizeVenueName,
	venueTokens,
} from "./normalize";
import { cityKey, sameVenue, unknownMatchesKnown } from "./venue-city";

/**
 * Venue-row deduplication (RULE 1 wiring). Two sources can mint the same
 * physical place under different spellings (`BLACK BOX` vs `Black Box -
 * Plataforma de Criação Artística de Leiria`), yielding two venue rows whose
 * different slugs then fork event identity. This pass fuses them.
 *
 * STRICT `venuesMatch` ONLY — the same matcher used by resolveOrCreateVenue.
 * Vague/placeholder venue rows ("Leiria (cidade)") never match anything, so
 * a city-level announcement is never used as a hub to collapse every venue
 * into one. Idempotent: a converged DB fuses 0 rows.
 *
 * Town-aware (C3): rows only fuse inside one town (`cityKey`), so
 * "Biblioteca Municipal" in Batalha and in Pombal stay two rows. A row with no
 * known town folds into a town's row only when its name matches venues of
 * exactly one town — the same null-city policy as `pickVenue`.
 *
 * The plan is pure (`planVenueMerge`); this function only loads and writes.
 */
export async function mergeDuplicateVenues(conn: Conn = db): Promise<number> {
	const venues = await conn
		.select({
			id: schema.venues.id,
			name: schema.venues.name,
			city: schema.venues.city,
			slug: schema.venues.slug,
			address: schema.venues.address,
			lat: schema.venues.lat,
			lng: schema.venues.lng,
		})
		.from(schema.venues);

	const counts = await conn
		.select({ venueId: schema.events.venue_id, n: count() })
		.from(schema.events)
		.groupBy(schema.events.venue_id);
	const eventCount = new Map<number, number>();
	for (const c of counts) {
		if (c.venueId != null) eventCount.set(c.venueId, c.n);
	}

	let merged = 0;
	for (const step of planVenueMerge(venues, eventCount)) {
		if (Object.keys(step.fill).length > 0) {
			await conn
				.update(schema.venues)
				.set(step.fill)
				.where(eq(schema.venues.id, step.canonicalId));
		}
		// Re-point the alias venues' events at the canonical row, then drop
		// the alias venue rows (event_sources reference events, not venues).
		await conn
			.update(schema.events)
			.set({ venue_id: step.canonicalId })
			.where(inArray(schema.events.venue_id, step.aliasIds));
		await conn
			.delete(schema.venues)
			.where(inArray(schema.venues.id, step.aliasIds));
		merged += step.aliasIds.length;
	}
	return merged;
}

export interface MergeVenue {
	id: number;
	name: string;
	city: string;
	slug: string;
	address: string | null;
	lat: number | null;
	lng: number | null;
}

/** One fused component: the surviving row, the rows folded into it, and what it inherits. */
export interface VenueMergeStep {
	canonicalId: number;
	aliasIds: number[];
	fill: Partial<Pick<MergeVenue, "city" | "address" | "lat" | "lng">>;
}

/**
 * How candidate pairs are found (C8). `blocked` (production) only compares
 * rows that share a block; `all-pairs` is the original quadratic scan, kept
 * as the reference the blocked plan is tested against.
 *
 * Blocks are (city key, normalized name) and (city key, discriminating
 * token). `venuesMatch` is true only for equal normalized names or a token
 * SUBSET with both sets non-empty, and a subset shares every token of the
 * smaller set, so every matching pair shares at least one block: blocking only
 * skips pairs that can never match, and the plan is identical.
 */
export type VenuePairing = "blocked" | "all-pairs";

const nameKey = (name: string) => normalizeTitle(normalizeVenueName(name));

/** Index rows under each of their block keys. */
function blockIndex<T>(
	rows: readonly T[],
	keysOf: (row: T) => string[],
): Map<string, T[]> {
	const index = new Map<string, T[]>();
	for (const row of rows) {
		for (const key of new Set(keysOf(row))) {
			const list = index.get(key) ?? [];
			list.push(row);
			index.set(key, list);
		}
	}
	return index;
}

/** Pure merge plan over a snapshot of the venue table (see mergeDuplicateVenues). */
export function planVenueMerge(
	venues: readonly MergeVenue[],
	eventCount: ReadonlyMap<number, number>,
	pairing: VenuePairing = "blocked",
): VenueMergeStep[] {
	const keyOf = new Map<number, string>();
	for (const v of venues) keyOf.set(v.id, cityKey(v.city));
	const town = (v: MergeVenue) => keyOf.get(v.id) ?? "";

	// Union-find on STRICT venuesMatch.
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		const p = parent.get(x);
		if (p === undefined || p === x) {
			if (p === undefined) parent.set(x, x);
			return x;
		}
		const root = find(p);
		parent.set(x, root);
		return root;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(rb, ra);
	};

	for (const v of venues) find(v.id);
	// Known towns: same town (city key) AND the strict matcher. Unknown-town
	// rows (`Leiria (distrito)`) fuse with each other the same way.
	if (pairing === "all-pairs") {
		for (const a of venues) {
			for (const b of venues) {
				if (a.id >= b.id) continue;
				if (sameVenue(a, b)) union(a.id, b.id);
			}
		}
	} else {
		// A vague row never matches anything, so it joins no block.
		const blocks = blockIndex(
			venues.filter((v) => !isVagueVenue(v.name, v.city)),
			(v) => [
				`${town(v)}|n:${nameKey(v.name)}`,
				...venueTokens(v.name, v.city).map((t) => `${town(v)}|t:${t}`),
			],
		);
		const tried = new Set<string>();
		for (const block of blocks.values()) {
			for (const a of block) {
				for (const b of block) {
					if (a.id >= b.id) continue;
					const pair = `${a.id}:${b.id}`;
					if (tried.has(pair)) continue;
					tried.add(pair);
					if (sameVenue(a, b)) union(a.id, b.id);
				}
			}
		}
	}
	// An unknown-town group folds into a known town only when its name is
	// unambiguous — it matches venues of exactly ONE town (C3). "Mercado
	// Municipal" with no town must not glue Batalha's and Pombal's markets
	// into one row through itself.
	const unknownGroups = new Map<number, MergeVenue[]>();
	for (const v of venues) {
		if (town(v) !== "") continue;
		const root = find(v.id);
		const list = unknownGroups.get(root) ?? [];
		list.push(v);
		unknownGroups.set(root, list);
	}
	// `unknownMatchesKnown` reads both names in the known row's town, and an
	// unknown row's tokens in any town are a subset of its town-less tokens,
	// so probing the known rows' own blocks with the town-less tokens still
	// finds every possible match.
	const knownBlocks =
		pairing === "blocked"
			? blockIndex(
					venues.filter((k) => town(k) !== "" && !isVagueVenue(k.name, k.city)),
					(k) => [
						`n:${nameKey(k.name)}`,
						...venueTokens(k.name, k.city).map((t) => `t:${t}`),
					],
				)
			: null;
	const fold = new Map<number, number[]>();
	for (const [root, members] of unknownGroups) {
		let pool: readonly MergeVenue[] = venues;
		if (knownBlocks) {
			const ids = new Set<number>();
			for (const u of members) {
				const keys = [
					`n:${nameKey(u.name)}`,
					...venueTokens(u.name).map((t) => `t:${t}`),
				];
				for (const key of keys) {
					for (const k of knownBlocks.get(key) ?? []) ids.add(k.id);
				}
			}
			pool = venues.filter((k) => ids.has(k.id));
		}
		const matches = pool.filter(
			(k) => town(k) !== "" && members.some((u) => unknownMatchesKnown(u, k)),
		);
		if (new Set(matches.map((k) => town(k))).size === 1) {
			fold.set(
				root,
				matches.map((k) => k.id),
			);
		}
	}
	for (const [root, known] of fold) {
		for (const id of known) union(root, id);
	}

	const byRoot = new Map<number, MergeVenue[]>();
	for (const v of venues) {
		const root = find(v.id);
		const list = byRoot.get(root) ?? [];
		list.push(v);
		byRoot.set(root, list);
	}

	// Canonical row preference: non-vague first, then fewest discriminating
	// tokens, then most events, then lowest id.
	const score = (v: MergeVenue): [number, number, number, number] => [
		isVagueVenue(v.name, v.city) ? 1 : 0,
		venueTokens(v.name, v.city).length,
		-(eventCount.get(v.id) ?? 0),
		v.id,
	];

	const steps: VenueMergeStep[] = [];
	for (const component of byRoot.values()) {
		if (component.length < 2) continue;
		const [canonical] = [...component].sort((a, b) => {
			const sa = score(a);
			const sb = score(b);
			return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2] || sa[3] - sb[3];
		});
		if (!canonical) continue;
		const aliasIds = component
			.filter((v) => v.id !== canonical.id)
			.map((v) => v.id);

		// The surviving row keeps what the aliases knew: a town when it had
		// none, and the geocode/address it lacked (deleting the alias must not
		// drop a pin). Its own values always win.
		const known = component.find((v) => town(v) !== "");
		const fill: VenueMergeStep["fill"] = {};
		if (town(canonical) === "" && known) fill.city = known.city;
		const located = component.find(
			(v) => v.id !== canonical.id && v.lat != null && v.lng != null,
		);
		if ((canonical.lat == null || canonical.lng == null) && located) {
			fill.lat = located.lat;
			fill.lng = located.lng;
		}
		const addressed = component.find(
			(v) => v.id !== canonical.id && v.address != null,
		);
		if (canonical.address == null && addressed) {
			fill.address = addressed.address;
		}
		steps.push({ canonicalId: canonical.id, aliasIds, fill });
	}
	return steps;
}

// Standalone execution: bun run src/scraper/venues.ts
if (import.meta.main) {
	const n = await mergeDuplicateVenues();
	console.log(JSON.stringify({ mergedAliases: n }));
}
