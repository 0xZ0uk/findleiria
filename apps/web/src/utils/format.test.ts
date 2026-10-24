import { describe, expect, test } from "bun:test";

import { nextLisbonMidnight, startOfLisbonDay } from "./format";

describe("nextLisbonMidnight", () => {
	test("is the start of the following Lisbon day (WEST, UTC+1)", () => {
		// 23:30 Lisbon on 24 Oct 2026 is 22:30 UTC; midnight is 23:00 UTC.
		const now = Date.UTC(2026, 9, 24, 22, 30);
		expect(nextLisbonMidnight(now)).toBe(Date.UTC(2026, 9, 24, 23, 0) / 1000);
	});

	test("just after midnight it points a whole day ahead", () => {
		// 00:05 Lisbon on 2 Jul 2026 (23:05 UTC the day before).
		const now = Date.UTC(2026, 6, 1, 23, 5);
		const next = nextLisbonMidnight(now);
		expect(next).toBe(startOfLisbonDay(now) + 86_400);
		expect(next).toBe(Date.UTC(2026, 6, 2, 23, 0) / 1000);
	});

	test("survives the autumn clock change (25-hour day)", () => {
		// 25 Oct 2026 is the 25h day: 00:00 WEST to 00:00 WET.
		const now = Date.UTC(2026, 9, 25, 12, 0);
		expect(nextLisbonMidnight(now)).toBe(Date.UTC(2026, 9, 26, 0, 0) / 1000);
	});

	test("survives the spring clock change (23-hour day)", () => {
		// 29 Mar 2026: 00:00 WET to 00:00 WEST.
		const now = Date.UTC(2026, 2, 29, 12, 0);
		expect(nextLisbonMidnight(now)).toBe(Date.UTC(2026, 2, 29, 23, 0) / 1000);
	});
});
