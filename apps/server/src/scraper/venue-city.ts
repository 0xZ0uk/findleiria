/**
 * Venue identity across towns (C3) — pure, no DB.
 *
 * A venue NAME does not identify a place: "Biblioteca Municipal", "Mercado
 * Municipal", "Cine-Teatro" exist in most of the 16 concelhos. A venue is
 * (name, town), so both venue-row resolution and the event fingerprint carry a
 * CITY KEY next to the name.
 *
 * The key is concelho-level: "Ordem" and "Marinha Grande" (one is a parish of
 * the other) are the same key, so two sources that word the town differently
 * still resolve one venue row and one fingerprint. A locality the places table
 * cannot place keys on its own normalized name.
 *
 * Unknown city (null, blank, or the `Leiria (distrito)` placeholder ingest
 * files such rows under) keys as "" — no town. See `pickVenue` for how those
 * resolve.
 */

import { municipalityOf } from "@events-tracker/api/places";

import {
	normalizeCity,
	normalizeTitle,
	normalizeVenueName,
	slugify,
	venuesMatch,
} from "./normalize";

/** City label for a venue row whose town no source told us. */
export const UNKNOWN_CITY = "Leiria (distrito)";

const UNKNOWN_CITY_NORM = normalizeTitle(UNKNOWN_CITY);

/** Values sources use for "no locality". */
const NO_CITY_KEYS = new Set(["", "n-d", "nd", "na"]);

/**
 * Concelho-level identity of a city string; "" when the town is unknown.
 * `Batalha` → `batalha`, `Ordem` → `marinha-grande`, `Leiria e arredores` →
 * `leiria`, `Leiria (distrito)` / null → "".
 */
export function cityKey(city: string | null | undefined): string {
	if (city == null) return "";
	const trimmed = city.trim();
	if (trimmed === "" || normalizeTitle(trimmed) === UNKNOWN_CITY_NORM) {
		return "";
	}
	const norm = normalizeCity(trimmed);
	const municipality = municipalityOf(trimmed) ?? municipalityOf(norm);
	const key = slugify(municipality ?? norm);
	return NO_CITY_KEYS.has(key) ? "" : key;
}

/** Base slug of a venue name — the pre-C3 venue slug (and fingerprint venue ref). */
export function venueBaseSlug(venueName: string): string {
	return slugify(normalizeVenueName(venueName)) || "venue-desconhecido";
}

export interface VenueRow {
	id: number;
	name: string;
	city: string;
	slug: string;
}

export type VenuePick =
	| {
			kind: "use";
			id: number;
			/** Adopting an unknown-town row: record the town we now know. */
			setCity?: string;
	  }
	| { kind: "create"; name: string; city: string; slug: string };

/**
 * Decide which venue row a (name, city) resolves to, given existing rows.
 *
 * Known town:
 *   1. a row with the same name in the same town (city key) — reuse;
 *   2. same-named rows exist but ALL have an unknown town — adopt that row and
 *      record the town (a null-city source minted it first);
 *   3. a spelling variant in the same town (strict `venuesMatch`) — reuse;
 *   4. otherwise create. The plain name slug when free, else the slug
 *      qualified with the town (`biblioteca-municipal-batalha`), so existing
 *      venue slugs never change and only the second town gets a suffix.
 *
 * Unknown town (null-city policy): reuse a same-named row only when the name
 * is UNAMBIGUOUS — every same-named row sits in one town (what BOL relies on:
 * "Teatro José Lúcio da Silva" exists once). When the name lives in several
 * towns we will not guess: the event goes to one shared unknown-town row
 * (`Leiria (distrito)`), created if needed.
 *
 * `rows` may be any superset of the same-named rows; steps 1, 2 and the
 * unknown-town branch only look at same-named rows, so a caller can try the
 * cheap slug-family subset first and only pass every row when that returns
 * `create` for a known town (step 3 needs them all).
 */
export function pickVenue(
	venueName: string,
	city: string | null,
	rows: readonly VenueRow[],
): VenuePick {
	const name = normalizeVenueName(venueName);
	const base = venueBaseSlug(venueName);
	const key = cityKey(city);
	const sameName = rows
		.filter((r) => r.slug === base || venueBaseSlug(r.name) === base)
		// The plain-slug row first (the pre-C3 owner), then oldest.
		.sort(
			(a, b) =>
				Number(b.slug === base) - Number(a.slug === base) || a.id - b.id,
		);
	const taken = new Set(rows.map((r) => r.slug));
	const freeSlug = (suffix: string): string => {
		if (!taken.has(base)) return base;
		const qualified = `${base}-${suffix}`;
		if (!taken.has(qualified)) return qualified;
		for (let n = 2; ; n++) {
			if (!taken.has(`${qualified}-${n}`)) return `${qualified}-${n}`;
		}
	};

	if (key !== "" && city != null) {
		const hit = sameName.find((r) => cityKey(r.city) === key);
		if (hit) return { kind: "use", id: hit.id };
		const first = sameName[0];
		if (first && sameName.every((r) => cityKey(r.city) === "")) {
			return { kind: "use", id: first.id, setCity: city.trim() };
		}
		const variant = rows
			.filter(
				(r) =>
					cityKey(r.city) === key && venuesMatch(name, r.name, city, r.city),
			)
			.sort((a, b) => a.id - b.id)[0];
		if (variant) return { kind: "use", id: variant.id };
		return {
			kind: "create",
			name: name || venueName.trim(),
			city: city.trim(),
			slug: freeSlug(key),
		};
	}

	const knownKeys = new Set(
		sameName.map((r) => cityKey(r.city)).filter((k) => k !== ""),
	);
	if (knownKeys.size === 1) {
		const only = sameName.find((r) => cityKey(r.city) !== "");
		if (only) return { kind: "use", id: only.id };
	}
	const bucket = sameName.find((r) => cityKey(r.city) === "");
	if (bucket) return { kind: "use", id: bucket.id };
	return {
		kind: "create",
		name: name || venueName.trim(),
		city: UNKNOWN_CITY,
		slug: freeSlug("distrito"),
	};
}

/**
 * The strict venue-row equivalence, town-aware: same city key and the strict
 * `venuesMatch`. Unknown-town rows are handled by the caller (they match a
 * known-town row only when unambiguous — see mergeDuplicateVenues).
 */
export function sameVenue(a: VenueRow, b: VenueRow): boolean {
	return (
		cityKey(a.city) === cityKey(b.city) &&
		venuesMatch(a.name, b.name, a.city, b.city)
	);
}

/**
 * Would unknown-town row `u` be the same venue as known-town row `k` if it sat
 * in k's town? (Strict `venuesMatch` evaluated in k's town.)
 */
export function unknownMatchesKnown(u: VenueRow, k: VenueRow): boolean {
	return venuesMatch(u.name, k.name, k.city, k.city);
}
