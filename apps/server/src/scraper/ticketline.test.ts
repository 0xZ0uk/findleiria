import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lisbonDay, toEpochInLisbon } from "./fingerprint";
import {
	parseDetail,
	parseSearch,
	SEARCH_URL,
	type SearchRow,
	scrape,
	toEpoch,
	toRawEvent,
} from "./ticketline";

const read = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8");

const searchHtml = read("tl-search.html");
const detail1Html = read("tl-detail.html"); // PIGS festival — aggregator page
const detail2Html = read("tl-detail2.html"); // leaf session — Leiria

const rowById = (rows: SearchRow[], id: string) => {
	const row = rows.find((r) => r.id === id);
	expect(row).toBeDefined();
	return row!;
};

describe("parseSearch (offline fixture)", () => {
	test("parses every search row (fixture has 12)", () => {
		expect(parseSearch(searchHtml, false).length).toBe(12);
	});

	test("PIGS ROCK FESTIVAL row: id, date, venue, category, url", () => {
		const pigs = rowById(parseSearch(searchHtml, false), "106704");
		expect(pigs.title).toBe("PIGS ROCK FESTIVAL");
		expect(pigs.date).toBe("2026-09-18");
		expect(pigs.venue).toBe("Pigs Arena");
		expect(pigs.categories).toEqual(["Festival"]);
		expect(pigs.url).toBe(
			"https://www.ticketline.pt/evento/pigs-rock-festival-106704",
		);
	});

	test("venue-scoped rows are flagged", () => {
		const pigs = rowById(parseSearch(searchHtml, true), "106704");
		expect(pigs.venueScoped).toBe(true);
	});
});

describe("parseDetail (offline fixtures)", () => {
	test("leaf detail resolves date, time, venue, city and prices", () => {
		const d = parseDetail(detail2Html);
		expect(d).not.toBeNull();
		expect(d?.date).toBe("2026-09-18");
		expect(d?.time).toBe("20:00");
		expect(d?.venue).toBe("Pigs Arena");
		expect(d?.city).toBe("Leiria");
		expect(d?.prices).toContain("12,89€");
		// 2026-09-18T20:00 Lisbon → epoch
		expect(toEpoch(d!.date, d!.time)).toBe(1789758000);
		expect(lisbonDay(toEpoch(d!.date, d!.time)!)).toBe("2026-09-18");
	});

	test("aggregator (festival parent) page has no resolvable session", () => {
		expect(parseDetail(detail1Html)).toBeNull();
	});
});

describe("toRawEvent (Leiria city scope)", () => {
	test("venue-scoped row is deterministically Leiria", () => {
		const pigs = rowById(parseSearch(searchHtml, true), "106704");
		const raw = toRawEvent(pigs, null);
		expect(raw).not.toBeNull();
		expect(raw!.city).toBe("Leiria");
		expect(raw!.slug).toBe("tl-106704");
	});

	test("text-search row whose venue names Leiria is kept without detail", () => {
		const chiado = rowById(parseSearch(searchHtml, false), "90459");
		const raw = toRawEvent(chiado, null);
		expect(raw).not.toBeNull();
		expect(raw!.city).toBe("Leiria");
	});

	test("non-Leiria row with no Leiria marker is dropped", () => {
		const rhythm = rowById(parseSearch(searchHtml, false), "106964");
		expect(toRawEvent(rhythm, null)).toBeNull();
	});

	test("detail address city wins over the row venue string", () => {
		const rhythm = rowById(parseSearch(searchHtml, false), "106964");
		const raw = toRawEvent(rhythm, {
			title: "Rhythm",
			date: "2027-04-06",
			time: null,
			venue: "Sala Grande",
			city: "Leiria",
			prices: [],
		});
		expect(raw).not.toBeNull();
		expect(raw!.city).toBe("Leiria");
	});
});

describe("S1 city + S2 impossible dates", () => {
	const row = (id: string, date: string, venue = "Teatro, Leiria") =>
		`<li itemscope itemtype="http://schema.org/Event"><a href="/evento/x-${id}" itemprop="url"></a><p itemprop="name">Show ${id}</p><span class="date" data-date="${date}"></span><p itemprop="location">${venue}</p></li>`;

	test("S1: a non-Leiria in-district detail city is kept, not hardcoded", () => {
		const rhythm = rowById(parseSearch(searchHtml, false), "106964");
		const raw = toRawEvent(rhythm, {
			title: "Rhythm",
			date: "2027-04-06",
			time: null,
			venue: "CCC",
			city: "Caldas da Rainha",
			prices: [],
		});
		expect(raw).not.toBeNull();
		expect(raw!.city).toBe("Caldas da Rainha");
	});

	test("S2: toEpoch returns null for 30/02 instead of throwing", () => {
		expect(toEpoch("2026-02-30", null)).toBeNull();
		expect(toEpoch("2026-02-28", "21:30")).not.toBeNull();
	});

	test("S2: one impossible date is skipped and counted; the rest still parse", async () => {
		const now = () => toEpochInLisbon(2026, 9, 1);
		const search = `<html><body><ul>${row("777001", "2026-02-30")}${row("90459", "2026-10-01")}</ul></body></html>`;
		const result = await scrape({
			fetchText: async (url: string) =>
				url === SEARCH_URL
					? search
					: url.includes("90459")
						? detail2Html
						: "<html><body></body></html>",
			sleep: async () => {},
			now,
			venueSearchUrl: SEARCH_URL,
		});
		expect(result.events.map((e) => e.slug)).toEqual(["tl-90459"]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("777001");
	});
});

describe("S3 failed detail fetch keeps the row", () => {
	test("dead detail is counted but the row survives via the search-row fallback", async () => {
		const now = () => toEpochInLisbon(2026, 9, 1);
		const row = `<li itemscope itemtype="http://schema.org/Event"><a href="/evento/x-555" itemprop="url"></a><p itemprop="name">Show 555</p><span class="date" data-date="2026-10-01"></span><p itemprop="location">Teatro, Leiria</p></li>`;
		const search = `<html><body><ul>${row}</ul></body></html>`;
		const result = await scrape({
			fetchText: async (url: string) => {
				if (url === SEARCH_URL) return search;
				throw new Error(`GET ${url} -> HTTP 500`);
			},
			sleep: async () => {},
			now,
			venueSearchUrl: SEARCH_URL,
		});
		expect(result.events.map((e) => e.slug)).toEqual(["tl-555"]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("HTTP 500");
	});
});

describe("scrape (mock deps, offline)", () => {
	test("filters to future Leiria events; dead detail counted not fatal", async () => {
		const now = () => toEpochInLisbon(2026, 9, 1); // 2026-09-01 00:00 Lisbon
		const fetchText = async (url: string) => {
			if (url === SEARCH_URL) {
				return searchHtml;
			}
			if (url.includes("90459")) {
				return detail2Html; // leaf, city Leiria → kept
			}
			if (url.includes("106704")) {
				throw new Error(`GET ${url} -> HTTP 500`);
			}
			return "<html><body></body></html>"; // no session → dropped
		};
		const result = await scrape({
			fetchText,
			sleep: async () => {},
			now,
			venueSearchUrl: SEARCH_URL, // reuse to keep the mock small
		});
		// 7 future-dated rows; only the Chiado one resolves to Leiria.
		expect(result.events.length).toBe(1);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("HTTP 500");
		expect(result.events[0]!.city).toBe("Leiria");
		expect(result.events[0]!.startAt).toBe(1789758000);
	});
});
