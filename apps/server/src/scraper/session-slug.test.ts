import { describe, expect, test } from "bun:test";

import { toEpochInLisbon } from "./fingerprint";
import { disambiguateSameDaySessions } from "./session-slug";
import type { RawEvent } from "./types";

const raw = (slug: string, startAt: number | null): RawEvent => ({
	title: "T",
	slug,
	description: null,
	startAt,
	endAt: null,
	dateText: null,
	venueName: "V",
	city: null,
	categories: [],
	imageUrl: null,
	url: "https://x",
});

describe("disambiguateSameDaySessions", () => {
	const d = (day: number, h: number, m = 0) =>
		toEpochInLisbon(2026, 10, day, h, m);

	test("earliest session keeps the slug regardless of input order", () => {
		const out = disambiguateSameDaySessions([
			raw("a", d(5, 21, 30)),
			raw("a", d(5, 18, 30)),
		]);
		expect(out.map((e) => e.slug)).toEqual(["a-2130", "a"]);
	});

	test("three sessions: later ones get their own time suffix", () => {
		const out = disambiguateSameDaySessions([
			raw("a", d(5, 15)),
			raw("a", d(5, 18)),
			raw("a", d(5, 21, 30)),
		]);
		expect(out.map((e) => e.slug)).toEqual(["a", "a-1800", "a-2130"]);
	});

	test("different days, undated, and identical instants are untouched", () => {
		const out = disambiguateSameDaySessions([
			raw("a", d(5, 21)),
			raw("a", d(6, 21)),
			raw("a", null),
			raw("a", d(5, 21)),
			raw("b", d(5, 22)),
		]);
		expect(out.map((e) => e.slug)).toEqual(["a", "a", "a", "a", "b"]);
	});

	test("a single-session item keeps its exact slug (existing rows stay put)", () => {
		const out = disambiguateSameDaySessions([raw("only", d(5, 21))]);
		expect(out[0]?.slug).toBe("only");
	});
});
