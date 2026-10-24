import { describe, expect, test } from "bun:test";

import {
	boundsOf,
	boundsOfAll,
	concelhoAt,
	insidePolygon,
	insideRing,
	polygonsOf,
	type Shape,
} from "./geo";

/**
 * A square around the district's own coordinates, in [lng, lat] order. Shaped
 * like a feature of `concelhos.json`, name under `properties` — the reason this
 * file has a test that reads the asset itself.
 */
const square = (
	name: string,
	west: number,
	south: number,
	east: number,
	north: number,
): Shape => ({
	properties: { name },
	geometry: {
		type: "Polygon",
		coordinates: [
			[
				[west, south],
				[east, south],
				[east, north],
				[west, north],
				[west, south],
			],
		],
	},
});

const leiria = square("Leiria", -9.0, 39.7, -8.7, 39.9);
const obidos = square("Óbidos", -9.3, 39.3, -9.1, 39.5);
const withHole: Shape = {
	properties: { name: "Com Buraco" },
	geometry: {
		type: "Polygon",
		coordinates: [
			[
				[-9.0, 39.0],
				[-8.0, 39.0],
				[-8.0, 40.0],
				[-9.0, 40.0],
				[-9.0, 39.0],
			],
			[
				[-8.8, 39.2],
				[-8.2, 39.2],
				[-8.2, 39.8],
				[-8.8, 39.8],
				[-8.8, 39.2],
			],
		],
	},
};

const twoIslands: Shape = {
	properties: { name: "Ilhas" },
	geometry: {
		type: "MultiPolygon",
		coordinates: [
			[
				[
					[-9.0, 39.0],
					[-8.9, 39.0],
					[-8.9, 39.1],
					[-9.0, 39.1],
					[-9.0, 39.0],
				],
			],
			[
				[
					[-8.6, 39.4],
					[-8.5, 39.4],
					[-8.5, 39.5],
					[-8.6, 39.5],
					[-8.6, 39.4],
				],
			],
		],
	},
};

describe("insideRing", () => {
	test("separates the middle from the outside", () => {
		const ring = leiria.geometry.coordinates as [number, number][][];
		expect(insideRing(-8.8, 39.8, ring[0] as never)).toBe(true);
		expect(insideRing(-9.5, 39.8, ring[0] as never)).toBe(false);
		expect(insideRing(-8.8, 39.0, ring[0] as never)).toBe(false);
	});

	test("reads the pair as lng, lat and not the other way round", () => {
		// Swapped, -8.8/39.8 is a point in the Atlantic off Portugal's west
		// coast and outside every concelho — the axis trap in one assertion.
		expect(
			insideRing(
				39.8,
				-8.8,
				(leiria.geometry.coordinates as [number, number][][])[0] as never,
			),
		).toBe(false);
	});
});

describe("insidePolygon", () => {
	test("treats a hole as outside", () => {
		expect(
			insidePolygon(-8.95, 39.55, withHole.geometry.coordinates as never),
		).toBe(true);
		expect(
			insidePolygon(-8.5, 39.5, withHole.geometry.coordinates as never),
		).toBe(false);
	});
});

describe("concelhoAt", () => {
	test("names the concelho holding the point", () => {
		expect(concelhoAt(-8.8, 39.8, [leiria, obidos])).toBe("Leiria");
		expect(concelhoAt(-9.2, 39.4, [leiria, obidos])).toBe("Óbidos");
	});

	test("returns null outside the district rather than the nearest one", () => {
		expect(concelhoAt(-9.15, 38.7, [leiria, obidos])).toBeNull();
		expect(concelhoAt(-8.6, 41.15, [leiria, obidos])).toBeNull();
	});

	test("handles a MultiPolygon with more than one island", () => {
		expect(polygonsOf(twoIslands)).toHaveLength(2);
		expect(concelhoAt(-8.55, 39.45, [twoIslands])).toBe("Ilhas");
		expect(concelhoAt(-8.75, 39.45, [twoIslands])).toBeNull();
	});
});

describe("boundsOf", () => {
	test("returns west, south, east, north", () => {
		expect(boundsOf(leiria)).toEqual([-9.0, 39.7, -8.7, 39.9]);
	});

	test("covers every island of a MultiPolygon", () => {
		expect(boundsOf(twoIslands)).toEqual([-9.0, 39.0, -8.5, 39.5]);
	});

	test("wraps the whole district in one box", () => {
		expect(boundsOfAll([leiria, obidos])).toEqual([-9.3, 39.3, -8.7, 39.9]);
	});
});

/**
 * The asset, read from disk. A square literals above cannot catch a consumer
 * that reads `shape.name` where `concelhos.json` writes `properties.name` — and
 * that mistake does not throw, it just puts every venue outside the district.
 * The coordinates are rows from the live `venues` table.
 */
test("the drawn district, as it is actually stored", async () => {
	const { features } = (await Bun.file(
		new URL("../../../apps/web/src/assets/concelhos.json", import.meta.url),
	).json()) as { features: Shape[] };
	expect(features).toHaveLength(16);
	// Castelo de Leiria, and the room the Museu de Leiria sits in.
	expect(concelhoAt(-8.8093811, 39.7471635, features)).toBe("Leiria");
	expect(concelhoAt(-8.8021448, 39.7416986, features)).toBe("Leiria");
	// The Alfândega do Porto, a row that has no business being pinned here.
	expect(concelhoAt(-8.6109, 41.1452, features)).toBeNull();
});
