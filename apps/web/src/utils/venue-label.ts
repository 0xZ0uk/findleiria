import { concelhoOf } from "./concelho";

export type VenueFacetItem = {
	slug: string;
	name: string;
	city: string | null;
};

/** Names compare without case or surrounding space: "Teatro X " is "teatro x". */
function nameKey(name: string): string {
	return name.trim().toLocaleLowerCase("pt");
}

/**
 * The text each venue gets in the "Local" filter, keyed by slug.
 *
 * Venues are told apart by slug, not by name, so two of them can share a name:
 * a "Biblioteca Municipal" in Batalha and another in Pombal. Listed bare they
 * are indistinguishable, so whenever two or more venues share a name each one
 * with a known town gets it appended — "Biblioteca Municipal (Batalha)". A name
 * held by only one venue stays as it is.
 *
 * The town is the concelho the venue folds onto, the same vocabulary as the
 * Concelho filter. A venue with no town, or two same-named venues in the same
 * town, keep the bare name: there is nothing true to add.
 */
export function venueLabels(venues: VenueFacetItem[]): Map<string, string> {
	const bySlug = new Map<string, VenueFacetItem>();
	for (const venue of venues) {
		if (!bySlug.has(venue.slug)) bySlug.set(venue.slug, venue);
	}

	const sharing = new Map<string, number>();
	for (const venue of bySlug.values()) {
		const key = nameKey(venue.name);
		sharing.set(key, (sharing.get(key) ?? 0) + 1);
	}

	const labels = new Map<string, string>();
	for (const venue of bySlug.values()) {
		const shared = (sharing.get(nameKey(venue.name)) ?? 0) > 1;
		const town = shared ? concelhoOf(venue.city) : "";
		const name = venue.name.trim();
		labels.set(venue.slug, town ? `${name} (${town})` : name);
	}
	return labels;
}
