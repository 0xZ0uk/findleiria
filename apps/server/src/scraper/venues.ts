import { db, schema } from "@events-tracker/db";
import { count, eq, inArray } from "drizzle-orm";

import { isVagueVenue, venueTokens } from "./normalize";
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
 */
export async function mergeDuplicateVenues(): Promise<number> {
	const venues = await db
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

	const counts = await db
		.select({ venueId: schema.events.venue_id, n: count() })
		.from(schema.events)
		.groupBy(schema.events.venue_id);
	const eventCount = new Map<number, number>();
	for (const c of counts) {
		if (c.venueId != null) eventCount.set(c.venueId, c.n);
	}

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
	for (const a of venues) {
		for (const b of venues) {
			if (a.id >= b.id) continue;
			if (sameVenue(a, b)) {
				union(a.id, b.id);
			}
		}
	}
	// An unknown-town group folds into a known town only when its name is
	// unambiguous — it matches venues of exactly ONE town (C3). "Mercado
	// Municipal" with no town must not glue Batalha's and Pombal's markets
	// into one row through itself.
	const unknownGroups = new Map<number, typeof venues>();
	for (const v of venues) {
		if (cityKey(v.city) !== "") continue;
		const root = find(v.id);
		const list = unknownGroups.get(root) ?? [];
		list.push(v);
		unknownGroups.set(root, list);
	}
	const fold = new Map<number, number[]>();
	for (const [root, members] of unknownGroups) {
		const matches = venues.filter(
			(k) =>
				cityKey(k.city) !== "" &&
				members.some((u) => unknownMatchesKnown(u, k)),
		);
		if (new Set(matches.map((k) => cityKey(k.city))).size === 1) {
			fold.set(
				root,
				matches.map((k) => k.id),
			);
		}
	}
	for (const [root, known] of fold) {
		for (const id of known) union(root, id);
	}

	const byRoot = new Map<number, typeof venues>();
	for (const v of venues) {
		const root = find(v.id);
		const list = byRoot.get(root) ?? [];
		list.push(v);
		byRoot.set(root, list);
	}

	// Canonical row preference: non-vague first, then fewest discriminating
	// tokens, then most events, then lowest id.
	type VenueWithTags = (typeof venues)[number];
	const score = (v: VenueWithTags): [number, number, number, number] => [
		isVagueVenue(v.name, v.city) ? 1 : 0,
		venueTokens(v.name, v.city).length,
		-(eventCount.get(v.id) ?? 0),
		v.id,
	];

	let merged = 0;
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
		const known = component.find((v) => cityKey(v.city) !== "");
		const fill: Partial<
			Pick<VenueWithTags, "city" | "address" | "lat" | "lng">
		> = {};
		if (cityKey(canonical.city) === "" && known) fill.city = known.city;
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
		if (Object.keys(fill).length > 0) {
			await db
				.update(schema.venues)
				.set(fill)
				.where(eq(schema.venues.id, canonical.id));
		}

		// Re-point the alias venues' events at the canonical row, then drop
		// the alias venue rows (event_sources reference events, not venues).
		await db
			.update(schema.events)
			.set({ venue_id: canonical.id })
			.where(inArray(schema.events.venue_id, aliasIds));
		await db.delete(schema.venues).where(inArray(schema.venues.id, aliasIds));

		merged += aliasIds.length;
	}
	return merged;
}

// Standalone execution: bun run src/scraper/venues.ts
if (import.meta.main) {
	const n = await mergeDuplicateVenues();
	console.log(JSON.stringify({ mergedAliases: n }));
}
