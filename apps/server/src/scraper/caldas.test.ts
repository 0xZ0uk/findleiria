import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { must } from "../test-helpers";
import {
	DEFAULT_VENUE,
	decodeEntities,
	MAX_LISTING_PAGES,
	parseCardDate,
	parseListingCards,
	scrape,
	slugFor,
	toRawEvent,
} from "./caldas";
import { toEpochInLisbon } from "./fingerprint";

const readFixture = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8");

const page1 = readFixture("caldas-listing-page1.html");
const page2 = readFixture("caldas-listing-page2.html");
const page3 = readFixture("caldas-listing-page3.html");

/** 2026-09-11 12:00 UTC ≈ "now" for deterministic tests. */
const NOW = Math.floor(Date.UTC(2026, 8, 11, 12, 0, 0) / 1000);

describe("parseListingCards (real page fixtures)", () => {
	test("page 1 yields 12 cards, one per server-rendered events-card", () => {
		const cards = parseListingCards(page1);
		expect(cards.length).toBe(12);
	});

	test("first card extracts slug/title/category/local start & end", () => {
		const first = must(parseListingCards(page1)[0]);
		expect(first.slug).toBe("em-caldas-o-que");
		expect(first.title).toBe("Em Caldas, o quê? setembro 2026");
		expect(first.category).toBe("Agenda mensal");
		expect(first.start).toEqual({ day: 1, month: 9, year: 2026 });
		expect(first.end).toEqual({ day: 30, month: 9, year: 2026 });
	});

	test("single-day event collapses start==end (Futsal)", () => {
		const futsal = parseListingCards(page1).find((c) =>
			c.slug.startsWith("futsal"),
		);
		expect(futsal).toBeDefined();
		expect(futsal?.start).toEqual({ day: 12, month: 9, year: 2026 });
		expect(futsal?.end).toEqual({ day: 12, month: 9, year: 2026 });
	});

	test("all three real pages parse to the observed 12/12/10 cards", () => {
		expect(parseListingCards(page2).length).toBe(12);
		expect(parseListingCards(page3).length).toBe(10);
	});

	test("every card has a sane slug, title, local year and known month", () => {
		for (const page of [page1, page2, page3]) {
			for (const c of parseListingCards(page)) {
				expect(c.slug).toMatch(/^[a-z0-9/-]+$/);
				expect(c.title.length).toBeGreaterThan(0);
				expect(c.start.year).toBe(2026);
				expect(c.end.year).toBe(2026);
				expect(c.start.month).toBeGreaterThanOrEqual(1);
				expect(c.start.month).toBeLessThanOrEqual(12);
				expect(c.end.month).toBeGreaterThanOrEqual(1);
				expect(c.end.month).toBeLessThanOrEqual(12);
			}
		}
	});
});

describe("parseCardDate / decodeEntities", () => {
	test("several months round-trip", () => {
		expect(parseCardDate("06", "set<!-- -->.", "&#x27;26")).toEqual({
			day: 6,
			month: 9,
			year: 2026,
		});
		expect(parseCardDate("01", "ago.", "&#x27;26")).toEqual({
			day: 1,
			month: 8,
			year: 2026,
		});
		expect(parseCardDate("26", "jun.", "&#x27;26")).toEqual({
			day: 26,
			month: 6,
			year: 2026,
		});
	});

	test("decodeEntities resolves the entities the cards emit", () => {
		expect(decodeEntities("&quot;As Corujas&#x27; não dormem&quot;")).toBe(
			'"As Corujas\' não dormem"',
		);
		expect(decodeEntities("Le Raincy &amp; Foz do Arelho")).toBe(
			"Le Raincy & Foz do Arelho",
		);
	});
});

describe("toRawEvent", () => {
	const pentatlo = parseListingCards(page1).find((c) =>
		c.slug.startsWith("campeonato-europeu-de-pentatlo"),
	) as {
		slug: string;
		title: string;
		category: string | null;
		start: { day: number; month: number; year: number };
		end: { day: number; month: number; year: number };
	};

	test("Pentatlo becomes a dated, district-local RawEvent (local dates, no UTC drift)", () => {
		const raw = toRawEvent(
			pentatlo,
			`https://www.mcr.pt/agenda/${pentatlo.slug}`,
			NOW,
		);
		expect(raw?.title).toBe("Campeonato Europeu de Pentatlo Moderno sub-15");
		expect(raw?.slug).toBe("cl-campeonato-europeu-de-pentatlo-moderno-sub-15");
		// Card shows 06 set. → 13 set. (local). The detail page's +00:00 field
		// would read 05/12 — we must use the local card dates.
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 9, 6));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 13, 23, 59));
		expect(raw?.venueName).toBe(DEFAULT_VENUE);
		expect(raw?.city).toBe(DEFAULT_VENUE);
		expect(raw?.dateText).toBeNull();
		expect(raw?.categories).toEqual(["Desporto"]);
	});

	test("already-past event returns null (never rolled forward)", () => {
		const past = toRawEvent(
			{
				slug: "x",
				title: "X",
				category: null,
				start: { day: 1, month: 1, year: 2020 },
				end: { day: 1, month: 1, year: 2020 },
			},
			"https://www.mcr.pt/agenda/x",
			NOW,
		);
		expect(past).toBeNull();
	});
});

describe("scrape (injected fetchText over the real fixtures)", () => {
	const fetchMap = new Map<string, string>([
		["https://www.mcr.pt/agenda?lang=pt&amount=12", page1],
		["https://www.mcr.pt/agenda?lang=pt&page=2&amount=12", page2],
		["https://www.mcr.pt/agenda?lang=pt&page=3&amount=12", page3],
	]);
	const fetchPage = async (u: string) => fetchMap.get(u) ?? "";

	const deps = (seen: string[]) => ({
		fetchText: fetchPage,
		sleep: async () => {},
		loadState: () => ({ seen }),
		saveState: () => {},
		now: NOW,
	});

	test("first run discovers 34 events, all in-scope, distinct slugs", async () => {
		const res = await scrape(deps([]), () => true);
		expect(res.failures).toBe(0);
		expect(res.firstError).toBeNull();
		expect(res.pagesFetched).toBe(4);
		expect(res.discovered).toBe(34);
		expect(res.events.length).toBe(34);
		const slugs = new Set(res.events.map((e) => e.slug));
		expect(slugs.size).toBe(34);
		expect(res.events.every((e) => e.slug.startsWith("cl-"))).toBe(true);
		expect(res.events.every((e) => e.city === "Caldas da Rainha")).toBe(true);
	});

	test("steady state emits nothing new once all slugs are seen", async () => {
		const seen = parseListingCards(page1)
			.concat(parseListingCards(page2))
			.concat(parseListingCards(page3))
			.map((c) => c.slug);
		const res = await scrape(deps(seen), () => true);
		expect(res.events.length).toBe(0);
		expect(res.discovered).toBe(34);
		expect(res.pagesFetched).toBe(4);
	});

	test("a dead listing page is skipped and the pages after it still parse", async () => {
		const res = await scrape(
			{
				...deps([]),
				fetchText: async (u: string) => {
					if (u.includes("page=2")) {
						throw new Error("HTTP 403");
					}
					return fetchMap.get(u) ?? "";
				},
			},
			() => true,
		);
		expect(res.pagesFetched).toBe(3);
		expect(res.discovered).toBe(22);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("page=2");
	});

	test("C7: seen is saved on commit only — emitted and gated-out cards, never the past ones", async () => {
		const saved: { seen: string[] }[] = [];
		const capture = (s: { seen: string[] }) => {
			saved.push(s);
		};
		const gated = await scrape(
			{ ...deps([]), saveState: capture },
			() => false,
		);
		expect(gated.events).toEqual([]);
		expect(saved).toHaveLength(0);
		gated.commit();
		expect(saved[0]?.seen).toHaveLength(34);

		// Years later every card is over: none is emitted, none is marked seen.
		const later = await scrape(
			{ ...deps([]), saveState: capture, now: NOW + 10 * 365 * 86_400 },
			() => true,
		);
		expect(later.events).toEqual([]);
		later.commit();
		expect(saved[1]?.seen).toEqual([]);
	});
});

describe("tolerances / constants", () => {
	test("MAX_LISTING_PAGES caps the walk", () => {
		expect(MAX_LISTING_PAGES).toBe(5);
	});
	test("slugFor prefixes cl-", () => {
		expect(slugFor("setas-6ranking-singulares-m/f")).toBe(
			"cl-setas-6ranking-singulares-m/f",
		);
	});
});

describe("malformed cards are reported, never thrown", () => {
	test("parseCardDate throws on an unknown month token — why the guard exists", () => {
		expect(() => parseCardDate("06", "xyz<!-- -->.", "&#x27;26")).toThrow();
	});

	test("a broken card is skipped and named, the other 11 survive", () => {
		const broken = page1.replace("set<!-- -->.", "xyz<!-- -->.");
		const reported: string[] = [];
		const cards = parseListingCards(broken, (r) => reported.push(r));
		expect(cards.length).toBe(11);
		expect(cards.some((c) => c.slug === "em-caldas-o-que")).toBe(false);
		expect(reported.length).toBe(1);
		expect(reported[0]).toContain("em-caldas-o-que");
		expect(parseListingCards(page1).length).toBe(12);
	});

	test("an impossible campaign date drops the card (null) instead of throwing", () => {
		const reported: string[] = [];
		const raw = toRawEvent(
			{
				slug: "x",
				title: "X",
				category: null,
				start: { day: 29, month: 2, year: 2023 },
				end: { day: 29, month: 2, year: 2023 },
			},
			"https://www.mcr.pt/agenda/x",
			NOW,
			(r) => reported.push(r),
		);
		expect(raw).toBeNull();
		expect(reported.length).toBe(1);
		expect(reported[0]).toContain("2023");
	});
});
