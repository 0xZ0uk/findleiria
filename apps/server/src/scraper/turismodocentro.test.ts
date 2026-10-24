import { describe, expect, test } from "bun:test";

import { isLeiriaDistrict } from "./district";
import { toEpochInLisbon } from "./fingerprint";
import {
	COUNTY_BASE,
	dayParts,
	EVENT_BASE,
	PER_PAGE,
	parseCentro,
	parseItems,
	parseTerms,
	scrape,
	type TurismoItem,
	toRawEvent,
} from "./turismodocentro";

/** 2026-09-12 12:00 UTC — the "now" every case below is judged against. */
const NOW = 1_789_214_400;

/** 2026-09-12T00:00Z, i.e. what the feed ships for a 12.09.2026 event. */
const SEPT_12 = 1_789_171_200;

const ROSTER = JSON.stringify([
	{ id: 47, name: "Leiria", slug: "leiria" },
	{ id: 63, name: "Óbidos", slug: "obidos" },
	{ id: 98, name: "Vila de Rei", slug: "vila-de-rei" },
]);

const event = (over: Record<string, unknown> = {}) => ({
	id: 1,
	slug: "feira-do-12",
	link: "https://turismodocentro.pt/evento/feira-do-12/",
	title: { rendered: "Feira do 12 &amp; Mostra de Artesanato" },
	content: { rendered: "<p>Feira mensal no <b>centro</b> da vila.</p>\n" },
	excerpt: { rendered: "<p>Feira mensal…</p>" },
	county_mirror: [47],
	destination_mirror: [105],
	centro: {
		image: "https://turismodocentro.pt/wp-content/uploads/feira.jpg",
		date_line: "12.09.2026",
		start_date: SEPT_12,
		end_date: SEPT_12,
	},
	...over,
});

const LISTING = JSON.stringify([event()]);

const item = (over: Partial<TurismoItem> = {}): TurismoItem => ({
	id: 1,
	slug: "feira-do-12",
	link: "https://turismodocentro.pt/evento/feira-do-12/",
	title: "Feira do 12 & Mostra de Artesanato",
	description: "Feira mensal no centro da vila.",
	imageUrl: "https://turismodocentro.pt/wp-content/uploads/feira.jpg",
	countyIds: [47],
	centro: {
		image: null,
		dateLine: "12.09.2026",
		startDate: SEPT_12,
		endDate: SEPT_12,
	},
	...over,
});

const counties = parseTerms(ROSTER);

describe("parseTerms", () => {
	test("maps ids to the concelho names the gate consumes", () => {
		expect(counties.get(47)).toBe("Leiria");
		expect(counties.get(63)).toBe("Óbidos");
		expect(counties.get(999)).toBeUndefined();
	});

	test("junk is an empty map, not a throw", () => {
		expect(parseTerms("{}").size).toBe(0);
		expect(parseTerms("nope").size).toBe(0);
		expect(parseItems("nope")).toEqual([]);
	});
});

describe("parseCentro", () => {
	test("reads the mirrored date fields", () => {
		expect(
			parseCentro({
				image: " x.jpg ",
				date_line: "12.09.2026",
				start_date: SEPT_12,
				end_date: SEPT_12,
			}),
		).toEqual({
			image: "x.jpg",
			dateLine: "12.09.2026",
			startDate: SEPT_12,
			endDate: SEPT_12,
		});
	});

	test("a missing start date stays null (row is undated, not day zero)", () => {
		expect(parseCentro({ date_line: "12.09.2026" }).startDate).toBeNull();
		expect(parseCentro(undefined)).toEqual({
			image: null,
			dateLine: null,
			startDate: null,
			endDate: null,
		});
	});
});

describe("dayParts", () => {
	test("takes the UTC calendar parts: the feed pins local midnight to UTC", () => {
		expect(dayParts(SEPT_12)).toEqual({ year: 2026, month: 9, day: 12 });
		expect(dayParts(0)).toEqual({ year: 1970, month: 1, day: 1 });
	});
});

describe("parseItems", () => {
	test("flattens the rendered blobs into plain text", () => {
		const rows = parseItems(LISTING);
		expect(rows.length).toBe(1);
		expect(rows[0]?.title).toBe("Feira do 12 & Mostra de Artesanato");
		expect(rows[0]?.description).toBe("Feira mensal no centro da vila.");
		expect(rows[0]?.countyIds).toEqual([47]);
		expect(rows[0]?.imageUrl).toBe(
			"https://turismodocentro.pt/wp-content/uploads/feira.jpg",
		);
	});

	test("truncates an over-long description", () => {
		const rows = parseItems(
			JSON.stringify([
				event({ content: { rendered: `<p>${"a".repeat(900)}</p>` } }),
			]),
		);
		expect(rows[0]?.description?.length).toBe(400);
	});

	test("a row without an id, slug, link or title is skipped", () => {
		expect(
			parseItems(
				JSON.stringify([
					event({ id: 0 }),
					event({ slug: "" }),
					event({ link: "" }),
					event({ title: { rendered: "   " } }),
				]),
			).length,
		).toBe(0);
	});

	test("junk JSON is an empty list, not a throw", () => {
		expect(parseItems("{}")).toEqual([]);
	});
});

describe("toRawEvent", () => {
	test("day-precision row: Lisbon midnight start, end of its own day", () => {
		const { raw, reason } = toRawEvent(item(), counties, isLeiriaDistrict, NOW);
		expect(reason).toBeNull();
		expect(raw?.startAt).toBe(1_789_167_600);
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 12, 23, 59));
		expect(raw?.dateText).toBeNull();
		expect(raw?.venueName).toBe("Leiria");
		expect(raw?.city).toBe("Leiria");
		expect(raw?.categories).toEqual([]);
	});

	test("isFree: free-entry wording is true, silence is null", () => {
		const run = (over: Partial<TurismoItem>) =>
			toRawEvent(item(over), counties, isLeiriaDistrict, NOW).raw?.isFree;
		expect(run({})).toBeNull();
		expect(run({ description: "Entrada gratuita." })).toBe(true);
		expect(run({ title: "Mostra de Artesanato - Entrada Livre" })).toBe(true);
	});

	test("a multi-day row ends at the end of its last day", () => {
		const { raw } = toRawEvent(
			item({
				centro: {
					image: null,
					dateLine: "13.09.2026<br>20.09.2026",
					startDate: 1_789_257_600, // 2026-09-13T00:00Z
					endDate: 1_789_862_400, // 2026-09-20T00:00Z
				},
			}),
			counties,
			isLeiriaDistrict,
			NOW,
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 9, 13));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 20, 23, 59));
	});

	test("a region-wide row is filed on its first in-district concelho", () => {
		const { raw, inDistrict } = toRawEvent(
			item({ countyIds: [63, 47] }),
			counties,
			isLeiriaDistrict,
			NOW,
		);
		expect(inDistrict).toEqual(["Óbidos", "Leiria"]);
		expect(raw?.city).toBe("Óbidos");
	});

	test("gate: a row whose concelhos are all outside the district is dropped", () => {
		const { raw, reason } = toRawEvent(
			item({ countyIds: [98] }),
			counties,
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("outOfDistrict");
	});

	test("a row with no county at all is dropped, never guessed into scope", () => {
		const { raw, reason } = toRawEvent(
			item({ countyIds: [] }),
			counties,
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("outOfDistrict");
	});

	test("a row without a start date is dropped as undated", () => {
		const { raw, reason } = toRawEvent(
			item({
				centro: { image: null, dateLine: null, startDate: null, endDate: null },
			}),
			counties,
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("undated");
	});

	test("a finished event is dropped", () => {
		const { raw, reason } = toRawEvent(
			item({
				centro: {
					image: null,
					dateLine: "10.09.2026",
					startDate: 1_788_998_400, // 2026-09-10T00:00Z
					endDate: 1_788_998_400,
				},
			}),
			counties,
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("past");
	});
});

describe("scrape", () => {
	const rosterFirst = async (url: string): Promise<string> => {
		if (url.startsWith(COUNTY_BASE)) {
			return ROSTER;
		}
		if (url.startsWith(EVENT_BASE)) {
			return LISTING;
		}
		throw new Error(`unexpected url ${url}`);
	};

	test("gated rows only, with the drop census reported", async () => {
		const rows = [
			event(),
			event({ id: 2, county_mirror: [63, 47] }),
			event({ id: 3, county_mirror: [98] }),
			event({
				id: 4,
				centro: {
					image: null,
					date_line: "10.09.2026",
					start_date: 1_788_998_400,
					end_date: 1_788_998_400,
				},
			}),
			event({
				id: 5,
				centro: {
					image: null,
					date_line: null,
					start_date: null,
					end_date: null,
				},
			}),
		];
		const urls: string[] = [];
		const result = await scrape(
			{
				fetchText: async (url) => {
					urls.push(url);
					return url.startsWith(COUNTY_BASE) ? ROSTER : JSON.stringify(rows);
				},
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(result.pagesFetched).toBe(2);
		expect(result.discovered).toBe(5);
		expect(result.events.length).toBe(2);
		expect(result.droppedOutOfDistrict).toBe(1);
		expect(result.droppedPast).toBe(1);
		expect(result.droppedUndated).toBe(1);
		expect(result.multiConcelho).toBe(1);
		expect(result.events[1]?.city).toBe("Óbidos");
		expect(result.failures).toBe(0);
		expect(result.firstError).toBeNull();
	});

	test("walks a second page only when the first is full", async () => {
		const full = Array.from({ length: PER_PAGE }, (_, i) =>
			event({ id: i + 1, slug: `evento-${i + 1}` }),
		);
		const pages: string[] = [];
		const result = await scrape({
			fetchText: async (url) => {
				if (url.startsWith(COUNTY_BASE)) {
					return ROSTER;
				}
				pages.push(url);
				return pages.length === 1
					? JSON.stringify(full)
					: JSON.stringify([event({ id: 999, slug: "evento-999" })]);
			},
			sleep: async () => {},
			now: NOW,
		});
		expect(pages).toEqual([
			`${EVENT_BASE}?per_page=${PER_PAGE}&page=1`,
			`${EVENT_BASE}?per_page=${PER_PAGE}&page=2`,
		]);
		expect(result.pagesFetched).toBe(3);
		expect(result.discovered).toBe(PER_PAGE + 1);
		expect(result.events.length).toBe(PER_PAGE + 1);
	});

	test("fail-closed: no concelho roster means no events, not ungated events", async () => {
		const result = await scrape(
			{
				fetchText: async (url) => {
					if (url.startsWith(COUNTY_BASE)) {
						throw new Error("roster 503");
					}
					return LISTING;
				},
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(result.events).toEqual([]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("roster 503");
		expect(result.pagesFetched).toBe(0);
	});

	test("a failed listing page keeps the pages already read and reports it", async () => {
		let calls = 0;
		const result = await scrape(
			{
				fetchText: async (url) => {
					if (url.startsWith(COUNTY_BASE)) {
						return ROSTER;
					}
					calls++;
					if (calls === 1) {
						return JSON.stringify(
							Array.from({ length: PER_PAGE }, (_, i) =>
								event({ id: i + 1, slug: `evento-${i + 1}` }),
							),
						);
					}
					throw new Error("page 2 timeout");
				},
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(result.events.length).toBe(PER_PAGE);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("page 2 timeout");
		expect(result.pagesFetched).toBe(2);
	});

	test("rosterFirst fixture returns the listing for the event endpoint", async () => {
		expect(await rosterFirst(`${EVENT_BASE}?per_page=${PER_PAGE}&page=1`)).toBe(
			LISTING,
		);
	});
});
