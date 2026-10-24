import { describe, expect, test } from "bun:test";

import {
	busiestPin,
	type PinRow,
	pinCoverage,
	pinRadius,
	pinTallies,
} from "./pins";

/**
 * Rows as the API hands them over, with the defaults of a place we can draw.
 */
function row(overrides: Partial<PinRow> = {}): PinRow {
	return {
		venueSlug: "teatro-jose-lucio-da-silva",
		venueName: "Teatro José Lúcio da Silva",
		venueCity: "Leiria",
		venueLat: 39.7467,
		venueLng: -8.8039,
		venueScope: "venue",
		...overrides,
	};
}

describe("pinTallies", () => {
	test("counts one pin per venue", () => {
		const pins = pinTallies([row(), row(), row()]);
		expect(pins).toHaveLength(1);
		expect(pins[0]?.count).toBe(3);
		expect(pins[0]?.name).toBe("Teatro José Lúcio da Silva");
	});

	test("a município's own name is never a pin", () => {
		const pins = pinTallies([
			row({
				venueSlug: "obidos",
				venueName: "Óbidos",
				venueScope: "concelho",
				venueLat: 39.36,
			}),
			row(),
		]);
		expect(pins.map((pin) => pin.slug)).toEqual(["teatro-jose-lucio-da-silva"]);
	});

	test("a settlement is a pin, and says so", () => {
		const pins = pinTallies([
			row({
				venueSlug: "vieira-de-leiria",
				venueName: "Vieira de Leiria",
				venueScope: "lugar",
			}),
		]);
		expect(pins[0]?.scope).toBe("lugar");
	});

	test("no coordinates, no pin — never a guess", () => {
		const pins = pinTallies([
			row({ venueLat: null }),
			row({ venueSlug: "outro", venueLng: null }),
			row({ venueSlug: "terceiro", venueLat: Number.NaN }),
			row({ venueSlug: "quarto", venueLat: 139.5 }),
		]);
		expect(pins).toEqual([]);
	});

	test("ranks the busiest first, ties by name", () => {
		const pins = pinTallies([
			row({ venueSlug: "a", venueName: "A" }),
			row({ venueSlug: "c", venueName: "C" }),
			row({ venueSlug: "b", venueName: "B" }),
			row({ venueSlug: "c" }),
			row({ venueSlug: "c" }),
		]);
		expect(pins.map((pin) => pin.name)).toEqual(["C", "A", "B"]);
		expect(pins[0]?.count).toBe(3);
	});

	test("a venue with no slug groups by its name", () => {
		const pins = pinTallies([
			row({ venueSlug: null }),
			row({ venueSlug: null }),
		]);
		expect(pins).toHaveLength(1);
		expect(pins[0]?.count).toBe(2);
		expect(pins[0]?.slug).toBe("teatro josé lúcio da silva");
	});

	test("a row with no name at all is skipped", () => {
		expect(pinTallies([row({ venueSlug: null, venueName: null })])).toEqual([]);
	});

	test("the pin's concelho is the folded one, not the freguesia", () => {
		const pins = pinTallies([row({ venueCity: "Gaeiras" })]);
		expect(pins[0]?.concelho).toBe("Óbidos");
	});

	test("an empty window has no pins", () => {
		expect(pinTallies([])).toEqual([]);
		expect(busiestPin([])).toBe(0);
	});
});

describe("pinRadius", () => {
	test("a single event is still visible", () => {
		expect(pinRadius(1, 40)).toBeGreaterThanOrEqual(3);
	});

	test("the busiest pin is bigger than a quiet one", () => {
		expect(pinRadius(40, 40)).toBeGreaterThan(pinRadius(4, 40));
	});

	test("the ramp is square-rooted, so a tenth of the peak is not a speck", () => {
		expect(pinRadius(4, 40) / pinRadius(40, 40)).toBeGreaterThan(0.3);
	});

	test("an empty window stays sane", () => {
		expect(pinRadius(0, 0)).toBeGreaterThan(0);
		expect(pinRadius(3, 0)).toBeGreaterThan(0);
	});
});

describe("pinCoverage", () => {
	test("counts what the pins cover against the whole window", () => {
		const coverage = pinCoverage([
			row(),
			row({ venueSlug: "vila", venueScope: "lugar" }),
			row({ venueSlug: "obidos", venueScope: "concelho" }),
			row({ venueSlug: "sem-coordenadas", venueLat: null }),
		]);
		expect(coverage).toEqual({
			placed: 2,
			pinned: 1,
			settlements: 1,
			total: 4,
		});
	});
});
