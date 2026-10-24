import { describe, expect, test } from "bun:test";

import { toEpochInLisbon } from "./fingerprint";
import { isExpired, lastInstant } from "./lifecycle";

const NOW = 1_800_000_000;

describe("isExpired", () => {
	test("start days ago, no end → expired", () => {
		expect(
			isExpired(
				{ start_at: NOW - 3 * 86_400, end_at: null, date_text: null },
				NOW,
			),
		).toBe(true);
	});

	test("past end → expired even if start is past too", () => {
		expect(
			isExpired(
				{ start_at: NOW - 200, end_at: NOW - 50, date_text: null },
				NOW,
			),
		).toBe(true);
	});

	test("end in the future → still running, not expired", () => {
		expect(
			isExpired(
				{ start_at: NOW - 200, end_at: NOW + 50, date_text: null },
				NOW,
			),
		).toBe(false);
	});

	test("start moments ago, no end → open-ended, lasts the whole Lisbon day", () => {
		// NOW is 2027-01-15 08:00 Lisbon; 100s earlier is the same day.
		expect(
			isExpired({ start_at: NOW - 100, end_at: null, date_text: null }, NOW),
		).toBe(false);
	});

	test("start exactly now → not expired (today-or-after rule)", () => {
		expect(
			isExpired({ start_at: NOW, end_at: null, date_text: null }, NOW),
		).toBe(false);
	});

	test("future start → not expired", () => {
		expect(
			isExpired({ start_at: NOW + 100, end_at: null, date_text: null }, NOW),
		).toBe(false);
	});

	test("undated rows never expire (start_at is a placeholder)", () => {
		expect(
			isExpired(
				{ start_at: NOW - 999_999, end_at: null, date_text: "em breve" },
				NOW,
			),
		).toBe(false);
		expect(
			isExpired(
				{ start_at: NOW - 999_999, end_at: NOW - 1, date_text: "agosto" },
				NOW,
			),
		).toBe(false);
	});
});

describe("isExpired — open-ended date-only rows", () => {
	// Date-only events are pinned to 00:00 Lisbon with no end_at.
	const cases: Array<[string, [number, number, number]]> = [
		["ordinary day", [2026, 9, 12]],
		["spring-forward day (23h)", [2026, 3, 29]],
		["fall-back day (25h)", [2026, 10, 25]],
	];

	for (const [label, [y, m, d]] of cases) {
		test(`${label}: not expired at 15:00 the same day, expired the next day`, () => {
			const row = {
				start_at: toEpochInLisbon(y, m, d),
				end_at: null,
				date_text: null,
			};
			expect(isExpired(row, toEpochInLisbon(y, m, d, 0, 5))).toBe(false);
			expect(isExpired(row, toEpochInLisbon(y, m, d, 15, 0))).toBe(false);
			expect(isExpired(row, toEpochInLisbon(y, m, d, 23, 59))).toBe(false);
			// First instant of the next Lisbon day (d + 1 may overflow the
			// month, so build it from the day's own end).
			expect(isExpired(row, lastInstant(row.start_at, null) + 1)).toBe(true);
		});
	}

	test("the open-ended day ends at 23:59:59 Lisbon, DST days included", () => {
		for (const [, [y, m, d]] of cases) {
			expect(lastInstant(toEpochInLisbon(y, m, d), null)).toBe(
				toEpochInLisbon(y, m, d, 23, 59) + 59,
			);
		}
	});

	test("a real end_at after start_at still wins over the day rule", () => {
		const start = toEpochInLisbon(2026, 9, 12);
		const end = toEpochInLisbon(2026, 9, 14, 23, 59);
		expect(lastInstant(start, end)).toBe(end);
		expect(
			isExpired(
				{ start_at: start, end_at: end, date_text: null },
				toEpochInLisbon(2026, 9, 13, 15, 0),
			),
		).toBe(false);
	});

	test("an end_at that does not follow start_at counts as open-ended", () => {
		const start = toEpochInLisbon(2026, 9, 12, 21, 0);
		expect(lastInstant(start, start)).toBe(
			toEpochInLisbon(2026, 9, 12, 23, 59) + 59,
		);
	});
});
