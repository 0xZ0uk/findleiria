import { describe, expect, test } from "bun:test";
import { meshGradient } from "./mesh-gradient";

/** `at 22% 31%` — every field has to sit inside its own tile. */
function positions(style: string): [number, number][] {
	return [...style.matchAll(/at (\d+)% (\d+)%/g)].map((match) => [
		Number(match[1]),
		Number(match[2]),
	]);
}

describe("meshGradient", () => {
	test("is stable for the same seed", () => {
		const seed = "feira-de-antiguidades-e-velharias-de-leiria-a7b3c7c1a600";
		expect(meshGradient(seed)).toEqual(meshGradient(seed));
	});

	test("gives different events different tiles", () => {
		const seeds = Array.from({ length: 40 }, (_, index) => `evento-${index}`);
		const tiles = new Set(
			seeds.map((seed) => meshGradient(seed).backgroundImage),
		);
		expect(tiles.size).toBe(seeds.length);
	});

	test("survives a seed with nothing in it", () => {
		const tile = meshGradient("");
		expect(tile.backgroundImage).toContain("radial-gradient");
		expect(tile.backgroundImage).not.toContain("NaN");
	});

	test("anchors every tile on amber", () => {
		for (const seed of ["a", "magusto-rock", "trail-do-chicharo", ""]) {
			expect(meshGradient(seed).backgroundImage).toContain("rgba(255, 140, 0");
		}
	});

	test("emits five fields, all inside the tile", () => {
		const { backgroundImage } = meshGradient(
			"ding-ding-dong-sons-com-sabor-a-natal",
		);
		expect(backgroundImage.match(/radial-gradient\(/g)?.length).toBe(5);
		const points = positions(backgroundImage);
		expect(points).toHaveLength(5);
		for (const [x, y] of points) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(100);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(100);
		}
	});

	// Amber owns 10–70° on the wheel. A seed landing in that band is rotated to
	// the cool side, so every tile mixes a counterweight against the amber field
	// instead of stacking three warm ones.
	test("never lets the ground hue sit inside amber's band", () => {
		for (const seed of ["a", "b", "c", "d", "e", "f", "g", "estiagem"]) {
			const hue = Number(
				meshGradient(seed).backgroundColor.match(/^hsl\((\d+)/)?.[1],
			);
			expect(hue < 10 || hue > 70).toBe(true);
		}
	});

	test("carries a ground so an image never lands on nothing", () => {
		expect(meshGradient("sabados-com-contos").backgroundColor).toMatch(
			/^hsl\(\d+ 48% 17%\)$/,
		);
	});

	// Near-opposite hues crossing mid-tile is what produced the grey-brown wash
	// that made early tiles look like faded photos. Keep the pair analogous.
	test("keeps the two hues analogous", () => {
		for (const seed of ["a", "b", "c", "trail-do-chicharo", "estiagem"]) {
			const hues = [
				...new Set(
					[...meshGradient(seed).backgroundImage.matchAll(/hsla\((\d+) /g)].map(
						(match) => Number(match[1]),
					),
				),
			];
			expect(hues).toHaveLength(2);
			const gap = Math.abs(hues[0] - hues[1]);
			const circular = Math.min(gap, 360 - gap);
			expect(circular).toBeGreaterThanOrEqual(60);
			expect(circular).toBeLessThanOrEqual(120);
		}
	});
});
