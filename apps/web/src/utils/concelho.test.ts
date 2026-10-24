import { describe, expect, test } from "bun:test";

import {
	districtRoster,
	heatOpacity,
	isDistrictConcelho,
	peak,
	tallyConcelhos,
} from "./concelho";

const rows = (...cities: (string | null)[]) =>
	cities.map((venueCity) => ({ venueCity }));

describe("tallyConcelhos", () => {
	test("folds a freguesia onto its município", () => {
		const tallies = tallyConcelhos(rows("Gaeiras", "Óbidos", "Gaeiras"));
		expect(tallies).toEqual([{ name: "Óbidos", count: 3, mappable: true }]);
	});

	test("ranks the busiest first", () => {
		const tallies = tallyConcelhos(
			rows("Leiria", "Óbidos", "Leiria", "Nazaré"),
		);
		expect(tallies.map((tally) => tally.name)).toEqual([
			"Leiria",
			"Nazaré",
			"Óbidos",
		]);
		expect(tallies[0]?.count).toBe(2);
	});

	test("a tie keeps a stable order", () => {
		const tallies = tallyConcelhos(rows("Nazaré", "Óbidos"));
		expect(tallies.map((tally) => tally.name)).toEqual(["Nazaré", "Óbidos"]);
	});

	test("a city outside the district is real data, not mappable, and visible", () => {
		const tallies = tallyConcelhos(rows("Coimbra", "Leiria"));
		expect(tallies).toContainEqual({
			name: "Coimbra",
			count: 1,
			mappable: false,
		});
		expect(tallies).toContainEqual({
			name: "Leiria",
			count: 1,
			mappable: true,
		});
	});

	test("a row with no city is counted out loud", () => {
		const tallies = tallyConcelhos(rows(null, "", "Leiria"));
		expect(tallies).toContainEqual({
			name: "Sem concelho",
			count: 2,
			mappable: false,
		});
	});

	test("an empty window is an empty tally", () => {
		expect(tallyConcelhos([])).toEqual([]);
	});
});

describe("heatOpacity", () => {
	test("rises with the count and never leaves the range", () => {
		const ramp = [1, 2, 5, 10, 100].map((count) => heatOpacity(count, 100));
		expect(ramp).toEqual([...ramp].sort((a, b) => a - b));
		for (const opacity of ramp) {
			expect(opacity).toBeGreaterThan(0);
			expect(opacity).toBeLessThanOrEqual(1);
		}
		expect(heatOpacity(100, 100)).toBeCloseTo(0.9, 5);
	});

	test("an empty concelho is faint but drawn, and an empty window is not a crash", () => {
		expect(heatOpacity(0, 100)).toBe(0.05);
		expect(heatOpacity(0, 0)).toBe(0.05);
	});

	test("one concelho alone does not fill the ramp to the top of the range", () => {
		// sqrt scaling: a lone event in a lone concelho reads as a small number,
		// not as the busiest place in the district.
		expect(heatOpacity(1, 1)).toBeLessThanOrEqual(1);
		expect(heatOpacity(1, 10)).toBeLessThan(heatOpacity(10, 10));
	});
});

describe("peak", () => {
	test("is the busiest tally, and zero when nothing is on", () => {
		expect(peak(tallyConcelhos(rows("Leiria", "Leiria", "Óbidos")))).toBe(2);
		expect(peak([])).toBe(0);
	});
});

describe("isDistrictConcelho", () => {
	test("knows the sixteen municípios and nothing else", () => {
		expect(isDistrictConcelho("Leiria")).toBe(true);
		expect(isDistrictConcelho("Caldas da Rainha")).toBe(true);
		expect(isDistrictConcelho("Gaeiras")).toBe(false);
		expect(isDistrictConcelho("")).toBe(false);
	});
});

describe("districtRoster", () => {
	test("lists every concelho the map draws, busy first, empties included", () => {
		const roster = districtRoster(
			tallyConcelhos(rows("Leiria", "Leiria", "Óbidos")),
		);
		expect(roster).toHaveLength(16);
		expect(roster[0]).toEqual({ name: "Leiria", count: 2, mappable: true });
		expect(roster[1]).toEqual({ name: "Óbidos", count: 1, mappable: true });
		expect(roster.at(-1)?.count).toBe(0);
		expect(roster.every((tally) => tally.mappable)).toBe(true);
	});

	test("drops what it cannot draw and keeps the rest in step with the map", () => {
		const roster = districtRoster(
			tallyConcelhos(rows("Coimbra", "Leiria", null)),
		);
		expect(roster.some((tally) => tally.name === "Coimbra")).toBe(false);
		expect(roster.some((tally) => tally.name === "Sem concelho")).toBe(false);
		expect(roster.find((tally) => tally.name === "Leiria")?.count).toBe(1);
	});
});
