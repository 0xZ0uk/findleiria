import { describe, expect, test } from "bun:test";

import { toEpochInLisbon } from "../fingerprint";
import {
	foldAccents,
	MONTH_NAME_ALT,
	monthFromName,
	monthFromPrefix,
	PT_MONTHS,
	ymdToEpoch,
} from "./pt-dates";

describe("PT_MONTHS / monthFromName", () => {
	test("covers every full name and 3-letter abbreviation", () => {
		const full = [
			"janeiro",
			"fevereiro",
			"março",
			"abril",
			"maio",
			"junho",
			"julho",
			"agosto",
			"setembro",
			"outubro",
			"novembro",
			"dezembro",
		];
		full.forEach((name, i) => {
			expect(monthFromName(name)).toBe(i + 1);
			expect(monthFromName(name.slice(0, 3))).toBe(i + 1);
		});
	});

	test("is case, accent and trailing-dot insensitive", () => {
		expect(monthFromName("MARÇO")).toBe(3);
		expect(monthFromName("Marco")).toBe(3);
		expect(monthFromName("Set.")).toBe(9);
		expect(monthFromName("  dez  ")).toBe(12);
	});

	test("rejects non-months and loose prefixes", () => {
		expect(monthFromName("")).toBeNull();
		expect(monthFromName("sexta")).toBeNull();
		expect(monthFromName("setemb")).toBeNull();
	});

	test("monthFromPrefix tolerates sloppy spellings", () => {
		expect(monthFromPrefix("Set.")).toBe(9);
		expect(monthFromPrefix("Setembro")).toBe(9);
		expect(monthFromPrefix("Março")).toBe(3);
		expect(monthFromPrefix("xyz")).toBeNull();
	});

	test("table keys are accent-folded", () => {
		for (const key of Object.keys(PT_MONTHS)) {
			expect(foldAccents(key)).toBe(key);
		}
	});
});

describe("MONTH_NAME_ALT", () => {
	test("lists longer names before their abbreviations", () => {
		const parts = MONTH_NAME_ALT.split("|");
		expect(parts.indexOf("setembro")).toBeLessThan(parts.indexOf("set"));
		expect(parts).toContain("março");
	});

	test("matches raw accented text", () => {
		const re = new RegExp(`\\b(${MONTH_NAME_ALT})\\b`, "i");
		expect(re.exec("12 de março de 2026")?.[1]).toBe("março");
		expect(re.exec("4 de Setembro")?.[1]).toBe("Setembro");
	});
});

describe("ymdToEpoch", () => {
	test("date only is 00:00 Lisbon", () => {
		expect(ymdToEpoch("2026-09-19")).toBe(toEpochInLisbon(2026, 9, 19));
	});

	test("time is read as Lisbon wall clock (summer and winter)", () => {
		expect(ymdToEpoch("2026-09-19", "21:30")).toBe(
			toEpochInLisbon(2026, 9, 19, 21, 30),
		);
		expect(ymdToEpoch("2026-01-19", "9:05")).toBe(
			toEpochInLisbon(2026, 1, 19, 9, 5),
		);
	});

	test("ignores trailing text after the date and seconds after the time", () => {
		expect(ymdToEpoch("2026-09-19T10:00:00+01:00", "21:30:00")).toBe(
			toEpochInLisbon(2026, 9, 19, 21, 30),
		);
	});

	test("unparseable time falls back to midnight", () => {
		expect(ymdToEpoch("2026-09-19", "tarde")).toBe(
			toEpochInLisbon(2026, 9, 19),
		);
	});

	test("null for missing, malformed or impossible dates", () => {
		expect(ymdToEpoch(null)).toBeNull();
		expect(ymdToEpoch("")).toBeNull();
		expect(ymdToEpoch("19/09/2026")).toBeNull();
		expect(ymdToEpoch("2026-02-31")).toBeNull();
		expect(ymdToEpoch("2026-13-01")).toBeNull();
	});
});
