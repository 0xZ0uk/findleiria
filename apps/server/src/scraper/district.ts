/**
 * Leiria district scope (SLICE_6 scope correction, roster fixed in SLICE_10).
 *
 * Original design filtered everything to the MUNICIPALITY of Leiria (city =
 * "Leiria"). Pedro corrected this on review: the tracker covers the whole
 * DISTRICT of Leiria — all 16 municipalities:
 *
 *   Alcobaça, Alvaiázere, Ansião, Batalha, Bombarral, Caldas da Rainha,
 *   Castanheira de Pêra, Figueiró dos Vinhos, Leiria, Marinha Grande, Nazaré,
 *   Óbidos, Pedrógão Grande, Peniche, Pombal, Porto de Mós
 *
 * The roster shipped with 14 and left Ansião and Peniche out, so those two
 * municipal sources — both configured, both parsing fine — had every event
 * gated out on `city` and contributed nothing. The roster and the
 * freguesia → município table now live in @events-tracker/api/places, shared
 * with the web facet fold, so the gate and the UI cannot disagree about scope.
 *
 * Freguesia-level city values (e.g. Marrazes, Bajouca, Caranguejeira —
 * parishes of the municipality of Leiria; Pedrogão — parish of Leiria;
 * Maceira — parish of Leiria) all belong to the district too.
 *
 * This module is the single authority for "is this event in scope" so every
 * source filters identically and the UI copy matches the scraper reality.
 */

import { knownVenueFor } from "@events-tracker/api/known-venues";
import {
	DISTRICT_MUNICIPALITIES,
	DISTRICT_PARISHES,
	normalizePlace,
} from "@events-tracker/api/places";

export { normalizePlace };

/** The 16 municipalities of Distrito de Leiria (normalized, lowercase). */
export const LEIRIA_DISTRICT_MUNICIPALITIES: readonly string[] =
	DISTRICT_MUNICIPALITIES.map(normalizePlace).sort();

/**
 * Freguesias (parishes) observed in source data, by municipality:
 * - of Leiria: Marrazes, Barosa, Colmeias, Caranguejeira, Bajouca,
 *   Santa Eufémia, Ortigosa, Monte Real, Maceira, Maceirinha, Pousos, Cortes…
 * - of Marinha Grande: Maceira (freguesia), Pedrogão is Leiria's.
 * Parish names are unique enough inside this domain to match directly.
 */
const KNOWN_PARISHES = [
	"marrazes",
	"barosa",
	"colmeias",
	"caranguejeira",
	"bajouca",
	"santa eufemia",
	"ortigosa",
	"monte real",
	"maceira",
	"maceirinha",
	"pousos",
	"cortes",
	"pedrogao",
	"carreira",
	"picos",
	"parceiros",
	"amieira",
	"barreira",
	"chainca",
	"coimbrao",
	"bidoeira de cima",
	"bidoeira de baixo",
	"regueira de pontes",
	"telhada",
	"vilar",
	"milagres",
	"memoria",
	"graca",
	"guia",
	"lameiro",
	"montes",
	"pelos",
	"carvide",
	"casal dos arcade",
	// freguesias seen in live data (SLICE_6 district run):
	"sao pedro de moel",
	"vieira de leiria",
	"mira d'aire",
	"mira de aire",
	"juncal",
	"sao jorge",
	// Caldas da Rainha freguesias that arrive through a neighbour's agenda
	// card ("Avenida do Mar, Foz do Arelho" — festasearraiais live data;
	// Salir do Porto appears inside the Tornada union's own name). Without
	// them the Óbidos source had no way to place the tail and blamed Óbidos
	// for a venue that sits in the next concelho.
	"foz do arelho",
	"salir do porto",
	"tornada",
	"carvalhal benfeito",
	"ordem",
	"benedita",
	"ribafria",
	// Alcobaca + Porto de Mos freguesias / localities (Cister FM source +
	// festasearraiais streetAddress evidence). Cister local LOCAL field is a
	// worked place name (e.g. "Tremoceira", "Vestiaria") rather than a
	// concelho -- these belong to the district and must gate in.
	"pedreiras",
	"tremoceira",
	"vestiaria",
	"alfeizerao",
	"aljubarrota",
	"barrio",
	"cela",
	"evora de alcobaca",
	"maiorga",
	"martinganca",
	"pataias",
	"sao martinho do porto",
	"turquel",
	"alcaria",
	"alqueidao da serra",
	"alvados",
	"arrimal",
	"calvaria de cima",
	"junceira",
	"mendiga",
	"sao bento",
	"serro ventoso",
] as const;

/**
 * Every known freguesia/lugar: the local roster above plus the shared fold
 * table in @events-tracker/api/places. The gate ("is this in scope?") and the
 * web facet ("which município is this?") are the same question, so they read
 * the same list instead of two rosters that drift apart.
 */
const ALL_PARISHES: readonly string[] = [
	...new Set<string>([...KNOWN_PARISHES, ...DISTRICT_PARISHES]),
];

/**
 * Every normalized place name that marks a string as district: the 16
 * municipalities plus all known freguesias/lugares. Exposed for callers that
 * need to RANK candidates by district likelihood (festasearraiais URL slugs)
 * instead of gate them one by one.
 */
export const DISTRICT_PLACE_NAMES: readonly string[] = [
	...new Set<string>([...LEIRIA_DISTRICT_MUNICIPALITIES, ...ALL_PARISHES]),
];

function isKnownParish(norm: string): boolean {
	return ALL_PARISHES.includes(norm);
}

/**
 * Anything embedding the district name is in scope ("leiria e arredores",
 * "leiria (cidade)", the "Leira" typo the leiriagenda source emits, venue
 * names containing the word, etc.). The typo check keeps the leira/leiria
 * stem (leir*) but requires a WORD BOUNDARY before it — bare /leir/ matches
 * the "o-leir-os" in "Oleiros" (Castelo Branco district), which leaked
 * through on the first festasearraiais run.
 */
function mentionsLeiriaName(norm: string): boolean {
	return /(^|[^a-z])leir/.test(norm);
}

/**
 * A locality (freguesia / lugar) of the district that is NOT one of the 14
 * municipalities. Rosters disagree on this field: viralagenda reports the
 * worked place ("Ordem", "São Pedro de Moel") while a municipal agenda
 * reports the concelho ("Marinha Grande") — the same event, two city strings,
 * one concelho. This is the discriminator the identity layer's vague↔specific
 * wildcard uses. A municipality name is a deliberate cross-concelho boundary
 * and never counts as a locality here.
 */
export function isDistrictLocality(city: string | null | undefined): boolean {
	if (!city) return false;
	const norm = normalizePlace(city);
	if (norm.length === 0 || norm === "?" || norm === "n/d") return false;
	if ((LEIRIA_DISTRICT_MUNICIPALITIES as readonly string[]).includes(norm)) {
		return false;
	}
	return isKnownParish(norm);
}

/**
 * District scope test. Accepts:
 *  - any of the 16 district municipalities (normalized)
 *  - freguesias of the municipality of Leiria (they ARE district)
 *  - strings embedding "leiria" ("Leiria e arredores", "Leiria (cidade)")
 *  - "Leira" typos (leiriagenda source emits these)
 * Rejects: Lisboa, Porto, Coimbra, Tomar, Santarém, Faro, "?", null, "N/D"…
 */
export function isLeiriaDistrict(city: string | null | undefined): boolean {
	if (!city) {
		return false;
	}
	const norm = normalizePlace(city);
	if (norm.length === 0 || norm === "?" || norm === "n/d") {
		return false;
	}
	if (mentionsLeiriaName(norm)) {
		return true;
	}
	if ((LEIRIA_DISTRICT_MUNICIPALITIES as readonly string[]).includes(norm)) {
		return true;
	}
	return isKnownParish(norm);
}

/**
 * True when the evidence names a venue we know sits in the district, even
 * though the row carries no place token to gate on. Curated in
 * @events-tracker/api/known-venues (SLICE_17) — e.g. O Pica Miolos, a Leiria
 * bar NoCartaz files under Coimbra with no locality on the row. The evidence is
 * the venue's own name taken from a card title's ` @ ` suffix.
 */
export function isKnownLeiriaVenue(
	evidence: string | null | undefined,
): boolean {
	return knownVenueFor(evidence) !== null;
}

/**
 * District scope for a row: the resolved place, OR a venue name we know is in
 * the district. Feeding the venue through the place gate already catches names
 * that embed a place ("Castelo de Leiria", "ÁGORA no Castelo de Leiria"); the
 * curated list catches names that carry no place token at all.
 *
 * `isLeiriaDistrict` is left exactly as it is — every other caller keeps its
 * behaviour; the venue-aware variant is used by sources whose rows can be filed
 * by name alone.
 */
export function inDistrictScope(
	city: string | null | undefined,
	venueEvidence?: string | null,
): boolean {
	return (
		isLeiriaDistrict(city) ||
		isLeiriaDistrict(venueEvidence) ||
		isKnownLeiriaVenue(venueEvidence)
	);
}
