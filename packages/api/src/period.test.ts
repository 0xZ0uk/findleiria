import { describe, expect, test } from "bun:test";

import {
	activePreset,
	PERIOD_PRESETS,
	presetRange,
	shiftDayKey,
	todayKey,
	weekdayIndex,
} from "./period";

describe("shiftDayKey", () => {
	test("crosses months", () => {
		expect(shiftDayKey("2026-09-28", 3)).toBe("2026-10-01");
		expect(shiftDayKey("2026-10-01", -1)).toBe("2026-09-30");
	});

	test("crosses years", () => {
		expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
		expect(shiftDayKey("2027-01-01", -1)).toBe("2026-12-31");
		expect(shiftDayKey("2026-12-31", 29)).toBe("2027-01-29");
	});

	test("handles a leap day", () => {
		expect(shiftDayKey("2028-02-28", 1)).toBe("2028-02-29");
		expect(shiftDayKey("2028-02-29", 1)).toBe("2028-03-01");
	});
});

describe("weekdayIndex", () => {
	test("is Monday-based", () => {
		expect(weekdayIndex("2026-09-14")).toBe(0); // Monday
		expect(weekdayIndex("2026-09-11")).toBe(4); // Friday
		expect(weekdayIndex("2026-09-12")).toBe(5); // Saturday
		expect(weekdayIndex("2026-09-13")).toBe(6); // Sunday
	});
});

describe("todayKey", () => {
	test("is a Lisbon day key, not a UTC one", () => {
		// 2026-09-11T23:30Z is already 00:30 on the 12th in Lisbon.
		const lateNightUtc = Date.UTC(2026, 8, 11, 23, 30);
		expect(todayKey(lateNightUtc)).toBe("2026-09-12");
		// 2026-09-12T08:00Z is 09:00 in Lisbon.
		expect(todayKey(Date.UTC(2026, 8, 12, 8, 0))).toBe("2026-09-12");
	});
});

describe("presetRange", () => {
	test("hoje and amanhã are single days", () => {
		expect(presetRange("hoje", "2026-09-12")).toEqual({
			from: "2026-09-12",
			to: "2026-09-12",
		});
		expect(presetRange("amanha", "2026-09-12")).toEqual({
			from: "2026-09-13",
			to: "2026-09-13",
		});
		expect(presetRange("amanha", "2026-12-31")).toEqual({
			from: "2027-01-01",
			to: "2027-01-01",
		});
	});

	test("7 dias and 30 dias are today plus six / plus 29", () => {
		expect(presetRange("7-dias", "2026-09-12")).toEqual({
			from: "2026-09-12",
			to: "2026-09-18",
		});
		expect(presetRange("30-dias", "2026-09-12")).toEqual({
			from: "2026-09-12",
			to: "2026-10-11",
		});
	});

	test("fim de semana on a Monday is the coming Saturday and Sunday", () => {
		expect(presetRange("fim-de-semana", "2026-09-14")).toEqual({
			from: "2026-09-19",
			to: "2026-09-20",
		});
	});

	test("fim de semana on a Friday starts tomorrow", () => {
		expect(presetRange("fim-de-semana", "2026-09-11")).toEqual({
			from: "2026-09-12",
			to: "2026-09-13",
		});
	});

	test("fim de semana inside the weekend means today", () => {
		// A weekend that already started is not "next weekend".
		expect(presetRange("fim-de-semana", "2026-09-12")).toEqual({
			from: "2026-09-12",
			to: "2026-09-13",
		});
		expect(presetRange("fim-de-semana", "2026-09-13")).toEqual({
			from: "2026-09-13",
			to: "2026-09-13",
		});
	});
});

describe("activePreset", () => {
	const today = "2026-09-12";

	test("recognises a preset's own range", () => {
		expect(activePreset("2026-09-12", "2026-09-12", today)).toBe("hoje");
		expect(activePreset("2026-09-12", "2026-09-13", today)).toBe(
			"fim-de-semana",
		);
		expect(activePreset("2026-09-12", "2026-10-11", today)).toBe("30-dias");
	});

	test("a hand-picked range lights no chip", () => {
		expect(activePreset("2026-09-15", "2026-09-22", today)).toBeNull();
	});

	test("an empty range (no date filter) lights no chip", () => {
		expect(activePreset("", "", today)).toBeNull();
	});

	test("every preset is reachable and distinct", () => {
		const ranges = PERIOD_PRESETS.map((p) =>
			JSON.stringify(presetRange(p.id, today)),
		);
		expect(new Set(ranges).size).toBe(PERIOD_PRESETS.length);
		for (const preset of PERIOD_PRESETS) {
			const range = presetRange(preset.id, today);
			expect(activePreset(range.from, range.to, today)).toBe(preset.id);
		}
	});
});
