import {
	DISTRICT_MUNICIPALITIES,
	municipalityOf,
} from "@events-tracker/api/places";

/**
 * Where a row's city sits on the map (SLICE_14).
 *
 * Sources report the worked place where a municipal agenda reports the
 * concelho, so without this fold "Gaeiras" and "Óbidos" were two concelhos and
 * Leiria's events sat in ten of them. An unplaceable city keeps its own name —
 * never a guess, never hidden.
 */
export function concelhoOf(city: string | null): string {
	return municipalityOf(city) ?? city ?? "";
}

const DISTRICT = new Set<string>(DISTRICT_MUNICIPALITIES);

/**
 * Concelhos we have an outline for. A name that fails this test is real data we
 * cannot draw (a city outside the district, or one the fold did not recognise),
 * and it gets counted out loud rather than dropped.
 */
export function isDistrictConcelho(name: string): boolean {
	return DISTRICT.has(name);
}

export type ConcelhoTally = {
	name: string;
	count: number;
	/** True when the name is one the map can point at. */
	mappable: boolean;
};

/**
 * Events per concelho, busiest first.
 *
 * Ties break alphabetically so the panel does not reshuffle between renders,
 * and the result is a plain array: the map wants a stable order to label, and
 * the ranking next to it wants the same list.
 */
export function tallyConcelhos(
	rows: { venueCity: string | null }[],
): ConcelhoTally[] {
	const counts = new Map<string, number>();
	let unplaced = 0;
	for (const row of rows) {
		const name = concelhoOf(row.venueCity);
		if (!name) {
			unplaced++;
			continue;
		}
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const tallies = [...counts].map(([name, count]) => ({
		name,
		count,
		mappable: isDistrictConcelho(name),
	}));
	tallies.sort(
		(a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt"),
	);
	if (unplaced > 0) {
		tallies.push({ name: "Sem concelho", count: unplaced, mappable: false });
	}
	return tallies;
}

/**
 * Every concelho in the district, busy ones first — the map's own roster.
 *
 * The map draws all sixteen outlines, so the ranking beside it lists all
 * sixteen: a concelho with nothing on stays selectable (and selectable by
 * keyboard, which the shapes are not), instead of existing only as an
 * unclickable shape.
 */
export function districtRoster(tallies: ConcelhoTally[]): ConcelhoTally[] {
	const counts = new Map(tallies.map((tally) => [tally.name, tally.count]));
	return DISTRICT_MUNICIPALITIES.map((name) => ({
		name,
		count: counts.get(name) ?? 0,
		mappable: true,
	})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt"));
}

/** The count the ramp is scaled to. Never zero, so an empty window stays sane. */
export function peak(tallies: ConcelhoTally[]): number {
	return tallies.reduce(
		(max, tally) => (tally.count > max ? tally.count : max),
		0,
	);
}

/**
 * Heat, on one hue.
 *
 * Activity has exactly one colour, the primary green, so intensity — not hue —
 * carries the magnitude: a square-root ramp, because counts here are lopsided (one concelho
 * can hold a fifth of the window) and a linear ramp would leave every other
 * concelho indistinguishable from empty. Zero is barely tinted rather than
 * blank: an empty concelho is still a concelho, and its outline is information.
 *
 * Opacity, not a blended colour string: the fill colour is the brand token
 * itself, so the map follows any token change without a second source of truth
 * for what the primary green is.
 */
export function heatOpacity(count: number, max: number): number {
	if (count <= 0 || max <= 0) return 0.05;
	return 0.12 + 0.78 * Math.sqrt(count / max);
}

/** The selected concelho is the one lit solid, so the ramp never competes. */
export const SELECTED_OPACITY = 0.92;
