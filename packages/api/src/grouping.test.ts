import { describe, expect, test } from "bun:test";

import {
	lisbonDayKey,
	mergeSameDaySessions,
	normalizeEventTitle,
} from "./grouping";

describe("normalizeEventTitle", () => {
	test("strips diacritics, case, punctuation", () => {
		expect(normalizeEventTitle("  Concerto: Música!  ")).toBe(
			"concerto musica",
		);
		expect(normalizeEventTitle("Teatro e Dança — anfiteatro")).toBe(
			"teatro e danca anfiteatro",
		);
	});

	test("folds to empty for symbol-only titles", () => {
		expect(normalizeEventTitle("***")).toBe("");
	});
});

describe("lisbonDayKey", () => {
	test("formats epoch seconds as Lisbon-local YYYY-MM-DD", () => {
		// 2026-09-05 12:00 UTC → same calendar day in Lisbon (WEST, UTC+1).
		expect(lisbonDayKey(1788609600)).toBe("2026-09-05");
	});

	test("maps late-UTC instants to the next Lisbon day", () => {
		// 2026-09-05 23:30 UTC → 2026-09-06 00:30 in Lisbon.
		expect(lisbonDayKey(1788651000)).toBe("2026-09-06");
	});
});

describe("mergeSameDaySessions", () => {
	const row = (
		id: number,
		title: string,
		venueId: number | null,
		startAt: number,
		endAt: number | null = null,
	) => ({ id, title, venueId, startAt, endAt });

	// 2026-09-05 Lisbon: 16:30 WEST = 15:30 UTC = 1788678600.
	const d1_1630 = 1788622200;
	const d1_1830 = 1788629400; // 18:30 Lisbon
	const d1_2130 = 1788640200; // 21:30 Lisbon
	// 2026-09-06 Lisbon 18:30 = 1788768600.
	const d2_1830 = 1788715800;

	test("returns single rows with sessionStarts populated", () => {
		const merged = mergeSameDaySessions([row(1, "Show", 1, d1_1830)]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.sessionStarts).toEqual([d1_1830]);
	});

	test("merges same title + venue + day into earliest row", () => {
		const merged = mergeSameDaySessions([
			row(1, "A Morgue", 7, d1_1830),
			row(2, "A Morgue", 7, d1_2130),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe(1);
		expect(merged[0]?.sessionStarts).toEqual([d1_1830, d1_2130]);
	});

	test("matches despite diacritics/case/punctuation differences", () => {
		const merged = mergeSameDaySessions([
			row(1, "Música no Claustro", 3, d1_1830),
			row(2, "musica no claustro", 3, d1_2130),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.sessionStarts).toEqual([d1_1830, d1_2130]);
	});

	test("does NOT merge across venues, days, or different shows", () => {
		const merged = mergeSameDaySessions([
			row(1, "Show", 1, d1_1830),
			row(2, "Show", 2, d1_1830), // other venue
			row(3, "Show", 1, d2_1830), // other day
			row(4, "Other Show", 1, d1_1830), // other show
		]);
		expect(merged).toHaveLength(4);
		for (const m of merged) {
			expect(m.sessionStarts).toHaveLength(1);
		}
	});

	test("handles null venueId (merges only same-title null-venue rows)", () => {
		const merged = mergeSameDaySessions([
			row(1, "Festival X", null, d1_1830),
			row(2, "Festival X", null, d1_2130),
			row(3, "Festival Y", null, d1_1830),
		]);
		expect(merged).toHaveLength(2);
		const fx = merged.find((m) => m.title === "Festival X");
		expect(fx?.sessionStarts).toEqual([d1_1830, d1_2130]);
	});

	test("dedupes identical start_at values", () => {
		const merged = mergeSameDaySessions([
			row(1, "Show", 1, d1_1830),
			row(2, "Show", 1, d1_1830),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.sessionStarts).toEqual([d1_1830]);
	});

	test("merges three sessions; earliest row wins and keeps group position", () => {
		const merged = mergeSameDaySessions([
			row(1, "Filler", 9, d1_1630),
			row(2, "Show", 7, d1_1830),
			row(3, "Show", 7, d1_1630),
			row(4, "Show", 7, d1_2130),
		]);
		expect(merged.map((m) => m.id)).toEqual([1, 2]);
		const show = merged[1];
		expect(show?.id).toBe(2);
		expect(show?.startAt).toBe(d1_1630);
		expect(show?.sessionStarts).toEqual([d1_1630, d1_1830, d1_2130]);
	});

	test("empty input", () => {
		expect(mergeSameDaySessions([])).toEqual([]);
	});
});
