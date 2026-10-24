/**
 * District geometry, as plain functions.
 *
 * `concelhos.json` is a rendering asset: sixteen município outlines with an
 * anchor per shape, generated once from Nominatim. This module is the part of
 * that geometry worth testing on its own — so anything that has to decide
 * whether a coordinate is *actually* inside a concelho (a geocode, a filter on
 * a map click) asks these functions instead of trusting a bounding box.
 *
 * Coordinates are GeoJSON order: `[lng, lat]`.
 */

export type Position = readonly [number, number];

/** A closed ring of positions. */
export type Ring = readonly Position[];

/** One outline, first ring outer and any further rings holes. */
export type Polygon = readonly Ring[];

export type Shape = {
	/** Where the drawn shape keeps its name — GeoJSON, as `concelhos.json` writes it. */
	readonly properties: { readonly name: string; readonly anchor?: Position };
	readonly geometry: {
		readonly type: "Polygon" | "MultiPolygon";
		readonly coordinates: Polygon | readonly Polygon[];
	};
};

/** Both geometry types as the same thing: a list of polygons. */
export function polygonsOf(shape: Shape): readonly Polygon[] {
	return shape.geometry.type === "Polygon"
		? [shape.geometry.coordinates as Polygon]
		: (shape.geometry.coordinates as readonly Polygon[]);
}

/**
 * Ray casting: count the ring edges crossed by a ray heading east from the
 * point. Odd crossings means inside. Ring edges are taken with `[lng, lat]`
 * unpacked explicitly — passing the pair in the wrong order is the one mistake
 * this kind of code makes, and it fails silently.
 */
export function insideRing(lng: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i] as Position;
		const [xj, yj] = ring[j] as Position;
		if (
			yi > lat !== yj > lat &&
			lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
		) {
			inside = !inside;
		}
	}
	return inside;
}

/** Even-odd across the rings, so a hole in an outline reads as outside. */
export function insidePolygon(
	lng: number,
	lat: number,
	polygon: Polygon,
): boolean {
	let inside = false;
	for (const ring of polygon) {
		if (insideRing(lng, lat, ring)) inside = !inside;
	}
	return inside;
}

/** The name of the concelho a point falls in, or null outside the district. */
export function concelhoAt(
	lng: number,
	lat: number,
	shapes: readonly Shape[],
): string | null {
	for (const shape of shapes) {
		for (const polygon of polygonsOf(shape)) {
			if (insidePolygon(lng, lat, polygon)) return shape.properties.name;
		}
	}
	return null;
}

/**
 * Bounding box as `[west, south, east, north]`, which is the order Nominatim's
 * `viewbox` wants — not GeoJSON's, and not the order the shape stores.
 */
export function boundsOf(shape: Shape): [number, number, number, number] {
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	for (const polygon of polygonsOf(shape)) {
		for (const [lng, lat] of polygon.flat()) {
			if (lng < west) west = lng;
			if (lng > east) east = lng;
			if (lat < south) south = lat;
			if (lat > north) north = lat;
		}
	}
	return [west, south, east, north];
}

/** The smallest box around every shape given. */
export function boundsOfAll(
	shapes: readonly Shape[],
): [number, number, number, number] {
	return shapes.reduce<[number, number, number, number]>(
		(box, shape) => {
			const [west, south, east, north] = boundsOf(shape);
			return [
				Math.min(box[0], west),
				Math.min(box[1], south),
				Math.max(box[2], east),
				Math.max(box[3], north),
			];
		},
		[
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		],
	);
}
