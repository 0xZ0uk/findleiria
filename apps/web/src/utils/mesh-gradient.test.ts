import { describe, expect, test } from "bun:test";
import { meshGradient } from "./mesh-gradient";

/** `at 22% 31%` — every field has to sit inside its own tile. */
function positions(style: string): [number, number][] {
	return [...style.matchAll(/at (\d+)% (\d+)%/g)].map((match) => [
		Number(match[1]),
		Number(match[2]),
	]);
}

/** The `r, g, b` of each field, in paint order. */
function fieldColors(style: string): string[] {
	return [...style.matchAll(/at \d+% \d+%, rgba\((\d+, \d+, \d+), /g)].map(
		(match) => match[1] ?? "",
	);
}

describe("meshGradient", () => {
	test("is stable for the same seed", () => {
		const seed = "feira-de-antiguidades-e-velharias-de-leiria-a7b3c7c1a600";
		expect(meshGradient(seed)).toEqual(meshGradient(seed));
		expect(meshGradient(seed, "food")).toEqual(meshGradient(seed, "food"));
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
		expect(tile.backgroundImage).not.toContain("undefined");
	});

	test("anchors the tile on the event's theme", () => {
		for (const seed of ["a", "magusto-rock", "trail-do-chicharo", ""]) {
			expect(fieldColors(meshGradient(seed, "music").backgroundImage)[0]).toBe(
				"201, 184, 255",
			);
			expect(fieldColors(meshGradient(seed, "food").backgroundImage)[0]).toBe(
				"255, 201, 163",
			);
		}
	});

	test("emits three fields in three different pastels, all inside the tile", () => {
		const { backgroundImage } = meshGradient(
			"ding-ding-dong-sons-com-sabor-a-natal",
		);
		expect(backgroundImage.match(/radial-gradient\(/g)?.length).toBe(3);
		expect(new Set(fieldColors(backgroundImage)).size).toBe(3);
		const points = positions(backgroundImage);
		expect(points).toHaveLength(3);
		for (const [x, y] of points) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(100);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(100);
		}
	});

	// A dark ground is what turned uncovered corners muddy; the tile stays in
	// the light family of its anchor.
	test("carries a light ground so an image never lands on nothing", () => {
		for (const seed of ["sabados-com-contos", "estiagem", ""]) {
			const channels = meshGradient(seed)
				.backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/)
				?.slice(1)
				.map(Number);
			expect(channels).toHaveLength(3);
			for (const channel of channels ?? []) {
				expect(channel).toBeGreaterThanOrEqual(230);
			}
		}
	});
});
