import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { must } from "../test-helpers";
import { toEpochInLisbon } from "./fingerprint";
import {
	cardVenueEvidence,
	categoriesFor,
	DEFAULT_STATE,
	epochFromRaw,
	isFeedVenue,
	LISTING,
	MAX_DETAIL_REQUESTS,
	type NocartazCard,
	type NocartazState,
	parseCards,
	parseDetail,
	parseItemList,
	type ScrapeDeps,
	scrape,
	titleVenue,
	toRawEvent,
} from "./nocartaz";

const readFixture = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8");

const listing = readFixture("nocartaz-listing.html");
const detailEvent = readFixture("nocartaz-detail-event.html");
const detailOutOfDistrict = readFixture("nocartaz-detail-out-of-district.html");
const detailFestival = readFixture("nocartaz-detail-festival.html");

/** 2026-09-12 12:00 UTC ≈ "now" for deterministic tests. */
const NOW = Math.floor(Date.UTC(2026, 8, 12, 12, 0, 0) / 1000);

const inDistrict = (city: string | null | undefined) =>
	["Leiria", "Nazaré", "Alcobaça", "Bombarral", "Pedrógão Grande"].includes(
		(city ?? "").trim(),
	);

/** A scrape whose deferred state the runner then commits (C7). */
async function scrapeCommitted(...args: Parameters<typeof scrape>) {
	const result = await scrape(...args);
	result.commit?.();
	return result;
}

describe("parseCards (real hub fixture)", () => {
	const cards = parseCards(listing);

	test("reads every server-rendered card", () => {
		expect(cards.length).toBe(8);
	});

	test("first card: attributes + markup agree, concelho chip is stripped", () => {
		const first = must(cards[0]);
		expect(first.id).toBe("06009145e171bc07");
		expect(first.title).toBe("Carolina de Deus @ Teatro José Lúcio da Silva");
		expect(first.venue).toBe("Teatro José Lúcio da Silva (TJLS)");
		expect(first.city).toBe("Leiria"); // not "· Leiria"
		expect(first.date).toBe("2026-09-11");
		expect(first.startsAt).toBe("2026-09-11T21:30:00");
		expect(first.genre).toBe("rock-pop");
		expect(first.free).toBe(false);
		expect(first.when).toBe("sex 11 set · 21:30");
		expect(first.description).toStartWith("A voz doce da nova pop nacional");
		expect(first.imageUrl).toStartWith("https://photos.bandsintown.com/");
		expect(first.url).toBe("https://www.nocartaz.pt/eventos/06009145e171bc07/");
	});

	test("is-free cards carry free=true", () => {
		expect(cards.find((c) => c.id === "b986d96186f069fe")?.free).toBe(true);
		expect(cards.filter((c) => c.free).length).toBe(1);
	});

	test("aggregator rows the hub could not file keep an empty concelho", () => {
		const santarem = must(cards.find((c) => c.id === "b5d9211358b0bd95"));
		expect(santarem.city).toBe("");
		expect(santarem.venue).toBe("");
		expect(santarem.title).toContain(
			"Sociedade Recreativa Operária de Santarém",
		);
	});

	test("a card with no pitch-line has a null description, not an empty string", () => {
		expect(
			cards.find((c) => c.id === "e842891968926cf0")?.description,
		).toBeNull();
	});

	test("the same id twice on a page yields one card", () => {
		const doubled = `<article class="event-card" data-id="x" data-concelho="Leiria"><h3>A</h3></article>
			<article class="event-card" data-id="x" data-concelho="Leiria"><h3>A</h3></article>`;
		expect(parseCards(doubled).length).toBe(1);
	});
});

describe("categoriesFor", () => {
	test("maps the hub's genre slugs onto canonical labels", () => {
		expect(categoriesFor("rock-pop")).toEqual(["Concertos"]);
		expect(categoriesFor("literatura")).toEqual(["Literatura"]);
		expect(categoriesFor("conferencia")).toEqual(["Conferências"]);
		expect(categoriesFor("exposicao")).toEqual(["Museus & Exposições"]);
		expect(categoriesFor("eletronica")).toEqual(["Clubbing"]);
		expect(categoriesFor("outro")).toEqual(["Outros"]);
	});

	test("an unmapped or empty genre is dropped, never passed through as a slug", () => {
		expect(categoriesFor("")).toEqual([]);
		expect(categoriesFor("surf-de-camarao")).toEqual([]);
	});
});

describe("epochFromRaw", () => {
	test("offset-suffixed timestamps are absolute", () => {
		expect(epochFromRaw("2026-09-19T20:00:11+01:00")).toBe(
			Math.floor(Date.parse("2026-09-19T20:00:11+01:00") / 1000),
		);
		expect(epochFromRaw("2026-09-19T20:00:11Z")).toBe(
			Math.floor(Date.parse("2026-09-19T20:00:11Z") / 1000),
		);
	});

	test("bare timestamps are Lisbon wall clock, not host local time", () => {
		// 2026-09-12 is inside WEST (+01:00): local midnight is 23:00Z the day before.
		expect(epochFromRaw("2026-09-13T00:00:00")).toBe(
			toEpochInLisbon(2026, 9, 13, 0, 0),
		);
		expect(epochFromRaw("2026-09-13")).toBe(toEpochInLisbon(2026, 9, 13, 0, 0));
		expect(epochFromRaw("2026-09-11T21:30:00")).toBe(
			toEpochInLisbon(2026, 9, 11, 21, 30),
		);
	});

	test("junk and impossible dates degrade to null instead of throwing", () => {
		expect(epochFromRaw("")).toBeNull();
		expect(epochFromRaw(null)).toBeNull();
		expect(epochFromRaw("11 setembro")).toBeNull();
		expect(epochFromRaw("2026-02-30T21:00:00")).toBeNull();
	});
});

describe("parseDetail (real detail fixtures)", () => {
	test("Event JSON-LD gives title, start, venue, locality", () => {
		const d = parseDetail(detailEvent);
		expect(d.title).toBe("Carolina de Deus @ Teatro José Lúcio da Silva");
		expect(d.startAt).toBe("2026-09-11T21:30:00");
		expect(d.venue).toBe("Teatro José Lúcio da Silva (TJLS)");
		expect(d.city).toBe("Leiria");
		expect(d.description).toContain(", Leiria.");
	});

	test("a multi-day Festival still has no endDate — the range is prose only", () => {
		const d = parseDetail(detailFestival);
		expect(d.city).toBe("Nazaré");
		expect(d.startAt).toBe("2026-09-13T00:00:00");
		expect(d.endAt).toBeNull();
		expect(d.description).toContain("de 4 a 13 de setembro");
	});

	test("a detail page with no Event block produces empty fields", () => {
		const d = parseDetail("<html><body>nope</body></html>");
		expect(d).toEqual({
			title: null,
			startAt: null,
			endAt: null,
			venue: null,
			city: null,
			description: null,
			imageUrl: null,
		});
	});
});

describe("toRawEvent", () => {
	const cards = parseCards(listing);
	const first = must(cards[0]);
	const santarem = must(cards.find((c) => c.id === "b5d9211358b0bd95"));

	test("an in-district card becomes a RawEvent keyed on the hub's own id", () => {
		const raw = must(
			toRawEvent(first, parseDetail(detailEvent), NOW, inDistrict),
		);
		expect(raw.slug).toBe("nocartaz-06009145e171bc07");
		expect(raw.city).toBe("Leiria");
		expect(raw.venueName).toBe("Teatro José Lúcio da Silva (TJLS)");
		expect(raw.startAt).toBe(toEpochInLisbon(2026, 9, 11, 21, 30));
		expect(raw.endAt).toBeNull();
		// `.when` is a display chip, not a machine date: `date_text` marks
		// UNDATED rows (they never expire, the digest lists them apart, and the
		// reconcile pass skips them), so a dated card keeps it null.
		expect(raw.dateText).toBeNull();
		expect(raw.categories).toEqual(["Concertos"]);
		expect(raw.url).toBe("https://www.nocartaz.pt/eventos/06009145e171bc07/");
	});

	test("data-free=1 is free; data-free=0 stays unknown, never paid", () => {
		const marionetas = must(cards.find((c) => c.id === "b986d96186f069fe"));
		expect(toRawEvent(marionetas, null, NOW, inDistrict)?.isFree).toBe(true);
		expect(toRawEvent(first, null, NOW, inDistrict)?.isFree).toBeNull();
	});

	test("an out-of-district aggregator row is dropped, not filed under Leiria", () => {
		expect(
			toRawEvent(santarem, parseDetail(detailOutOfDistrict), NOW, inDistrict),
		).toBeNull();
	});

	test("the detail's locality rescues a row the hub left unfiled", () => {
		const unfiled = { ...santarem, city: "" };
		const raw = must(
			toRawEvent(
				unfiled,
				{ ...parseDetail(detailFestival), city: "Nazaré" },
				NOW,
				inDistrict,
			),
		);
		expect(raw.city).toBe("Nazaré");
	});

	test("card-only data is enough when the detail fetch failed", () => {
		const raw = must(toRawEvent(first, null, NOW, inDistrict));
		expect(raw.city).toBe("Leiria");
		expect(raw.venueName).toBe("Teatro José Lúcio da Silva (TJLS)");
		expect(raw.description).toContain("A voz doce");
	});

	test("card starts-at is the fallback when the detail has no date", () => {
		const raw = must(
			toRawEvent(
				first,
				{ ...parseDetail(detailEvent), startAt: null },
				NOW,
				inDistrict,
			),
		);
		expect(raw.startAt).toBe(toEpochInLisbon(2026, 9, 11, 21, 30));
	});

	test("an event already over is dropped", () => {
		const past = Math.floor(Date.UTC(2026, 8, 1, 0, 0, 0) / 1000);
		const card = {
			...first,
			date: "2026-06-01",
			startsAt: "2026-06-01T21:00:00",
		};
		expect(
			toRawEvent(
				card,
				{ ...parseDetail(detailEvent), startAt: null },
				past,
				inDistrict,
			),
		).toBeNull();
	});

	test("a card with no readable date is dropped rather than minted", () => {
		const card = { ...first, date: "", startsAt: "" };
		expect(
			toRawEvent(
				card,
				{ ...parseDetail(detailEvent), startAt: null },
				NOW,
				inDistrict,
			),
		).toBeNull();
	});
});

describe("isFeedVenue", () => {
	const first = must(parseCards(listing)[0]);
	const card = (over: Partial<NocartazCard>): NocartazCard => ({
		...first,
		...over,
	});

	test("a venue name that repeats the feed slug is the feed, not a room", () => {
		expect(
			isFeedVenue(
				"museu-vidro-marinha-grande",
				"Museu do Vidro - Marinha Grande",
			),
		).toBe(true);
		expect(isFeedVenue("agenda-obidos", "Agenda Cultural Óbidos")).toBe(true);
		expect(
			isFeedVenue(
				"cm-mgrande-eventos",
				"Câmara Municipal da Marinha Grande - Agenda",
			),
		).toBe(true);
	});

	test("a real room keeps its name", () => {
		expect(isFeedVenue("tjls-leiria", "Teatro José Lúcio da Silva")).toBe(
			false,
		);
		expect(
			isFeedVenue(
				"bandsintown-leiria",
				"Sociedade Recreativa Operária de Santarém",
			),
		).toBe(false);
	});

	test("a feed-fed row ships its concelho instead of the feed's own name", () => {
		const raw = toRawEvent(
			card({
				venue: "Museu do Vidro - Marinha Grande",
				venueSlug: "museu-vidro-marinha-grande",
				city: "Marinha Grande",
			}),
			null,
			NOW,
			() => true,
		);
		expect(raw?.venueName).toBe("Marinha Grande");
	});

	test("a card with no clock time keeps its day at midnight (no date_text)", () => {
		const raw = toRawEvent(
			card({ date: "2026-11-05", startsAt: "", when: "qui 05 nov" }),
			null,
			NOW,
			() => true,
		);
		expect(raw?.dateText).toBeNull();
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 11, 5, 0, 0));
	});
});

describe("scrape", () => {
	const cardHtml = (
		id: string,
		city: string,
		date: string,
		time = "21:00:00",
	) =>
		`<article class="event-card" data-id="${id}" data-concelho="${city}" data-date="${date}" data-starts-at="${date}T${time}" data-genre="rock-pop" data-free="0">
			<a class="card-link" href="/eventos/${id}/"><div class="card-body"><span class="when">sáb 12 set · 21:00</span>
			<h3>Evento ${id}</h3><span class="where"><span>Venue ${id}</span><span class="concelho">· ${city}</span></span>
			<div class="badges"></div></div></a></article>`;
	const listingHtml = `<html><body><div class="events">
		${cardHtml("aaaaaaaaaaaaaaaa", "Leiria", "2026-10-01")}
		${cardHtml("bbbbbbbbbbbbbbbb", "Alcobaça", "2026-10-02")}
		</div></body></html>`;
	const detailWith = (city: string, date: string) =>
		`<script type="application/ld+json">{"@type":"Event","name":"Detalhe","startDate":"${date}T21:00:00","location":{"name":"Sala","address":{"addressLocality":"${city}"}}}</script>`;

	function deps(
		over: Partial<ScrapeDeps> & { responses?: Record<string, string> } = {},
	) {
		const fetched: string[] = [];
		const saved: NocartazState[] = [];
		const responses = over.responses ?? {};
		const base: ScrapeDeps = {
			fetchText: async (url: string) => {
				fetched.push(url);
				const body =
					responses[url] ??
					(url === LISTING ? listingHtml : detailWith("Leiria", "2026-10-01"));
				if (body.startsWith("ERR:")) {
					throw new Error(body.slice(4));
				}
				return body;
			},
			sleep: async () => {},
			loadState: () => ({ details: {} }),
			saveState: (s) => saved.push(s),
			now: NOW,
			// SLICE_17 scans every district hub in production; the fixtures here
			// stub one hub unless a test names the others it wants scanned.
			hubs: ["leiria"],
		};
		return { deps: { ...base, ...over }, fetched, saved };
	}

	test("one listing fetch, then one detail fetch per unseen card", async () => {
		const { deps: d, fetched, saved } = deps();
		const result = await scrapeCommitted(d, inDistrict);
		expect(result.pagesFetched).toBe(3);
		expect(result.discovered).toBe(2);
		expect(result.events.length).toBe(2);
		expect(result.failures).toBe(0);
		expect(fetched).toEqual([
			LISTING,
			"https://www.nocartaz.pt/eventos/aaaaaaaaaaaaaaaa/",
			"https://www.nocartaz.pt/eventos/bbbbbbbbbbbbbbbb/",
		]);
		expect(Object.keys(must(saved[0]).details).sort()).toEqual([
			"aaaaaaaaaaaaaaaa",
			"bbbbbbbbbbbbbbbb",
		]);
	});

	test("a cached detail is reused — no refetch, same rich event", async () => {
		const cache: NocartazState = {
			details: {
				aaaaaaaaaaaaaaaa: {
					title: "Detalhe cached",
					startAt: "2026-10-01T21:00:00",
					endAt: null,
					venue: "Sala",
					city: "Leiria",
					description: "descrição completa",
					imageUrl: "https://www.nocartaz.pt/og/aaaaaaaaaaaaaaaa.webp",
					cardWhen: "2026-10-01 21:00",
				},
			},
		};
		const { deps: d, fetched } = deps({ loadState: () => cache });
		const result = await scrapeCommitted(d, inDistrict);
		expect(fetched).toEqual([
			LISTING,
			"https://www.nocartaz.pt/eventos/bbbbbbbbbbbbbbbb/",
		]);
		const cached = must(
			result.events.find((e) => e.slug === "nocartaz-aaaaaaaaaaaaaaaa"),
		);
		expect(cached.title).toBe("Detalhe cached");
		expect(cached.description).toBe("descrição completa");
		expect(cached.imageUrl).toBe(
			"https://www.nocartaz.pt/og/aaaaaaaaaaaaaaaa.webp",
		);
	});

	describe("C5 cached detail vs rescheduled card", () => {
		const entry = (cardWhen?: string) => ({
			title: "Detalhe cached",
			startAt: "2026-09-20T21:00:00",
			endAt: null,
			venue: "Sala",
			city: "Leiria",
			description: null,
			imageUrl: null,
			...(cardWhen ? { cardWhen } : {}),
		});
		const aUrl = "https://www.nocartaz.pt/eventos/aaaaaaaaaaaaaaaa/";

		test("the card's date changed: detail is refetched and the NEW date wins", async () => {
			// Cached when the card listed 20 Sep; the card now lists 1 Oct.
			const cache: NocartazState = {
				details: { aaaaaaaaaaaaaaaa: entry("2026-09-20 21:00") },
			};
			const { deps: d, fetched, saved } = deps({ loadState: () => cache });
			const result = await scrapeCommitted(d, inDistrict);
			expect(fetched).toContain(aUrl);
			const ev = must(
				result.events.find((e) => e.slug === "nocartaz-aaaaaaaaaaaaaaaa"),
			);
			expect(ev.startAt).toBe(toEpochInLisbon(2026, 10, 1, 21, 0));
			expect(must(saved[0]).details.aaaaaaaaaaaaaaaa?.cardWhen).toBe(
				"2026-10-01 21:00",
			);
		});

		test("a legacy entry with no cardWhen is refetched once", async () => {
			const cache: NocartazState = {
				details: { aaaaaaaaaaaaaaaa: entry() },
			};
			const { deps: d, fetched } = deps({ loadState: () => cache });
			await scrapeCommitted(d, inDistrict);
			expect(fetched).toContain(aUrl);
		});

		test("a failed refetch drops the stale detail: the card's fresh date ships", async () => {
			const cache: NocartazState = {
				details: { aaaaaaaaaaaaaaaa: entry("2026-09-20 21:00") },
			};
			const { deps: d, saved } = deps({
				loadState: () => cache,
				responses: { [aUrl]: "ERR: 500 boom" },
			});
			const result = await scrapeCommitted(d, inDistrict);
			const ev = must(
				result.events.find((e) => e.slug === "nocartaz-aaaaaaaaaaaaaaaa"),
			);
			expect(ev.startAt).toBe(toEpochInLisbon(2026, 10, 1, 21, 0));
			expect(must(saved[0]).details).not.toHaveProperty("aaaaaaaaaaaaaaaa");
		});

		test("an ItemList-only card (no date) keeps its cached detail and cardWhen", async () => {
			const itemListOnly = `<html><body><script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"url":"${aUrl}","name":"Evento a"}]}</script></body></html>`;
			const cache: NocartazState = {
				details: { aaaaaaaaaaaaaaaa: entry("2026-09-20 21:00") },
			};
			const {
				deps: d,
				fetched,
				saved,
			} = deps({
				loadState: () => cache,
				responses: { [LISTING]: itemListOnly },
			});
			await scrapeCommitted(d, inDistrict);
			expect(fetched).toEqual([LISTING]);
			expect(must(saved[0]).details.aaaaaaaaaaaaaaaa?.cardWhen).toBe(
				"2026-09-20 21:00",
			);
		});
	});

	test("cache is pruned to the ids the page still lists", async () => {
		const cache: NocartazState = {
			details: {
				aaaaaaaaaaaaaaaa: {
					title: null,
					startAt: null,
					endAt: null,
					venue: null,
					city: null,
					description: null,
					imageUrl: null,
				},
				"gone-forever": {
					title: null,
					startAt: null,
					endAt: null,
					venue: null,
					city: null,
					description: null,
					imageUrl: null,
				},
			},
		};
		const { deps: d, saved } = deps({ loadState: () => cache });
		await scrapeCommitted(d, inDistrict);
		expect(Object.keys(must(saved[0]).details).sort()).toEqual([
			"aaaaaaaaaaaaaaaa",
			"bbbbbbbbbbbbbbbb",
		]);
	});

	test("a failed detail fetch keeps the card event and does not cache it", async () => {
		const { deps: d, saved } = deps({
			responses: {
				"https://www.nocartaz.pt/eventos/aaaaaaaaaaaaaaaa/": "ERR: 500 boom",
			},
		});
		const result = await scrapeCommitted(d, inDistrict);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("500 boom");
		expect(result.events.map((e) => e.slug).sort()).toEqual([
			"nocartaz-aaaaaaaaaaaaaaaa",
			"nocartaz-bbbbbbbbbbbbbbbb",
		]);
		expect(must(saved[0]).details).toHaveProperty("bbbbbbbbbbbbbbbb");
		expect(must(saved[0]).details).not.toHaveProperty("aaaaaaaaaaaaaaaa");
	});

	test("an out-of-district card is not emitted even though its detail fetched", async () => {
		const { deps: d } = deps({
			responses: {
				"https://www.nocartaz.pt/eventos/aaaaaaaaaaaaaaaa/": detailWith(
					"Santarém",
					"2026-10-01",
				),
			},
		});
		const result = await scrapeCommitted(d, inDistrict);
		expect(result.events.map((e) => e.slug)).toEqual([
			"nocartaz-bbbbbbbbbbbbbbbb",
		]);
	});

	test("the detail budget caps fetches; over-budget cards still ship from card data", async () => {
		const many = `<html><body><div class="events">${Array.from(
			{ length: MAX_DETAIL_REQUESTS + 2 },
			(_, i) => cardHtml(String(i).padStart(16, "0"), "Leiria", "2026-10-01"),
		).join("")}</div></body></html>`;
		let detailFetches = 0;
		const { deps: d } = deps({
			fetchText: async (url: string) => {
				if (url === LISTING) {
					return many;
				}
				detailFetches++;
				return detailWith("Leiria", "2026-10-01");
			},
		});
		const result = await scrapeCommitted(d, inDistrict);
		expect(detailFetches).toBe(MAX_DETAIL_REQUESTS);
		expect(result.failures).toBe(2);
		expect(result.firstError).toContain("detail budget exhausted");
		expect(result.events.length).toBe(MAX_DETAIL_REQUESTS + 2);
	});

	test("a dead listing page fails the source once, with the url in the message", async () => {
		const { deps: d } = deps({
			responses: { [LISTING]: "ERR: 503 unavailable" },
		});
		const result = await scrapeCommitted(d, inDistrict);
		expect(result.events).toEqual([]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toStartWith(LISTING);
		expect(result.firstError).toContain("503 unavailable");
		expect(result.pagesFetched).toBe(0);
	});

	test("S6: a dead listing page is fetched ONCE (http.ts owns retries)", async () => {
		const { deps: d, fetched } = deps({
			responses: { [LISTING]: "ERR: 404 gone" },
		});
		await scrapeCommitted(d, inDistrict);
		expect(fetched).toEqual([LISTING]);
	});

	test("S7: a listing that parses to zero cards is a counted failure", async () => {
		const { deps: d } = deps({
			responses: { [LISTING]: "<html><body>Just a moment...</body></html>" },
		});
		const result = await scrapeCommitted(d, inDistrict);
		expect(result.events).toEqual([]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("zero cards");
		expect(result.firstError).toContain(LISTING);
	});

	test("a source with no cached state starts empty", () => {
		expect(DEFAULT_STATE).toEqual({ details: {} });
	});
});

// SLICE_17 — rows NoCartaz cannot localize. An aggregator-fed row carries an
// empty `data-concelho`, an empty `.where` span, and a detail page whose
// location is just "Portugal"; the venue survives only in the card title. These
// tests pin the ways such a row is admitted — and the ways it is not.
describe("SLICE_17 — untagged rows, known venues", () => {
	const untagged = (
		id: string,
		title: string,
		date = "2026-10-01",
		distrito = "Coimbra",
		feed = "bandsintown-coimbra",
	) =>
		`<article class="event-card has-thumb" data-concelho="" data-distrito="${distrito}" data-venue="${feed}" data-date="${date}" data-starts-at="${date}T21:00:00" data-genre="rock-pop" data-free="0" data-id="${id}">
			<a class="card-link" href="/eventos/${id}/"><div class="card-body"><span class="when">sáb 12 set · 21:00</span>
			<h3>${title}</h3><span class="where"> <span></span><span class="concelho">· </span> </span>
			<div class="badges"></div></div></a></article>`;

	const titledCard = (id: string, title: string) =>
		`<article class="event-card" data-id="${id}" data-concelho="Leiria" data-distrito="Leiria" data-venue="tjls-leiria" data-date="2026-10-01" data-starts-at="2026-10-01T21:00:00" data-genre="rock-pop" data-free="0">
			<a class="card-link" href="/eventos/${id}/"><div class="card-body"><h3>${title}</h3>
			<span class="where"><span>Teatro José Lúcio da Silva</span><span class="concelho">· Leiria</span></span>
			<div class="badges"></div></div></a></article>`;

	/** A detail page as NoCartaz serves aggregator rows: country only, no locality. */
	const countryDetail = (date: string) =>
		`<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicEvent","name":"Detalhe","startDate":"${date}T21:00:00","location":{"@type":"Place","name":"Portugal","address":{"@type":"PostalAddress","addressRegion":"Coimbra","addressCountry":"PT"}}}</script>`;

	const LEIRIA_HUB = LISTING;
	const COIMBRA_HUB = "https://www.nocartaz.pt/distrito/coimbra/";
	const emptyHub = "<html><body></body></html>";

	/** Fails loudly on any fetch the test did not plan for. */
	function harness(
		responses: Record<string, string>,
		over: Partial<ScrapeDeps> = {},
	) {
		const fetched: string[] = [];
		const base: ScrapeDeps = {
			fetchText: async (url: string) => {
				fetched.push(url);
				const body = responses[url];
				if (body === undefined) {
					throw new Error(`unexpected fetch: ${url}`);
				}
				if (body.startsWith("ERR:")) {
					throw new Error(body.slice(4));
				}
				return body;
			},
			sleep: async () => {},
			loadState: () => ({ details: {} }),
			saveState: () => {},
			now: NOW,
			hubs: ["leiria"],
		};
		return { deps: { ...base, ...over }, fetched };
	}

	test("titleVenue reads the venue the markup does not carry", () => {
		expect(titleVenue("Baleia Baleia Baleia @ O Pica Miolos")).toBe(
			"O Pica Miolos",
		);
		expect(titleVenue("Chimera Black @ O Pica Miolos")).toBe("O Pica Miolos");
		expect(titleVenue("Diga 33 – Poesia no Teatro")).toBeNull();
		expect(titleVenue("@ O Pica Miolos")).toBeNull();
		expect(titleVenue("Artista @")).toBeNull();
		expect(titleVenue(`Artista @ ${"V".repeat(61)}`)).toBeNull();
		expect(titleVenue(null)).toBeNull();
	});

	test("cardVenueEvidence prefers the markup, falls back to the title", () => {
		const cards = parseCards(
			untagged("aaaaaaaaaaaaaaaa", "Banda @ O Pica Miolos") +
				titledCard("bbbbbbbbbbbbbbbb", "Outro"),
		);
		expect(cardVenueEvidence(must(cards[0]))).toBe("O Pica Miolos");
		expect(cardVenueEvidence(must(cards[1]))).toBe(
			"Teatro José Lúcio da Silva",
		);
	});

	test("parseItemList reads event ids and names; dedupes; ignores sala links", () => {
		const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
			{"@type":"ListItem","position":1,"url":"https://www.nocartaz.pt/eventos/1a7f6837bb86d0cd/","name":"Baleia Baleia Baleia @ O Pica Miolos"},
			{"@type":"ListItem","position":2,"url":"https://www.nocartaz.pt/salas/bandsintown-coimbra/","name":"Feed"},
			{"@type":"ListItem","position":3,"url":"https://www.nocartaz.pt/eventos/1a7f6837bb86d0cd/","name":"duplicado"}]}</script>`;
		expect(parseItemList(html)).toEqual([
			{ id: "1a7f6837bb86d0cd", name: "Baleia Baleia Baleia @ O Pica Miolos" },
		]);
	});

	test("a row with a known venue and no locality ships with its true concelho", async () => {
		const { deps: d } = harness({
			[LEIRIA_HUB]: `<html><body>${untagged("cccccccccccccccc", "Baleia Baleia Baleia @ O Pica Miolos")}</body></html>`,
			"https://www.nocartaz.pt/eventos/cccccccccccccccc/":
				countryDetail("2026-10-01"),
		});
		const result = await scrape(d);
		expect(result.events.map((e) => e.slug)).toEqual([
			"nocartaz-cccccccccccccccc",
		]);
		const event = must(result.events[0]);
		expect(event.city).toBe("Leiria"); // never the aggregator's Coimbra
		expect(event.venueName).toBe("O Pica Miolos"); // never "Portugal"
	});

	test("the same row with an unknown venue is still dropped", async () => {
		const { deps: d } = harness({
			[LEIRIA_HUB]: `<html><body>${untagged("dddddddddddddddd", "Banda X @ Bar Desconhecido")}</body></html>`,
			"https://www.nocartaz.pt/eventos/dddddddddddddddd/":
				countryDetail("2026-10-01"),
		});
		expect((await scrape(d)).events).toEqual([]);
	});

	test("a misfiled row is found on another district's hub — allowlist hits only", async () => {
		const { deps: d, fetched } = harness(
			{
				[LEIRIA_HUB]: emptyHub,
				[COIMBRA_HUB]: `<html><body>
					${untagged("eeeeeeeeeeeeeeee", "Chimera Black @ O Pica Miolos", "2026-10-02")}
					${titledCard("ffffffffffffffff", "Teatro de Coimbra")}
					</body></html>`,
				"https://www.nocartaz.pt/eventos/eeeeeeeeeeeeeeee/":
					countryDetail("2026-10-02"),
			},
			{ hubs: ["leiria", "coimbra"] },
		);
		const result = await scrape(d);
		expect(result.events.map((e) => e.slug)).toEqual([
			"nocartaz-eeeeeeeeeeeeeeee",
		]);
		expect(must(result.events[0]).city).toBe("Leiria");
		// the other district's own event on that page is not even detail-fetched
		expect(fetched).not.toContain(
			"https://www.nocartaz.pt/eventos/ffffffffffffffff/",
		);
	});

	test("a misfiled row only listed in another hub's ItemList is found too", async () => {
		const { deps: d } = harness(
			{
				[LEIRIA_HUB]: emptyHub,
				[COIMBRA_HUB]: `<html><body><script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"url":"https://www.nocartaz.pt/eventos/28592c47db0ef640/","name":"Chimera Black @ O Pica Miolos"}]}</script></body></html>`,
				"https://www.nocartaz.pt/eventos/28592c47db0ef640/":
					countryDetail("2026-10-03"),
			},
			{ hubs: ["leiria", "coimbra"] },
		);
		const result = await scrape(d);
		expect(result.events.map((e) => e.slug)).toEqual([
			"nocartaz-28592c47db0ef640",
		]);
		expect(must(result.events[0]).city).toBe("Leiria");
		expect(must(result.events[0]).venueName).toBe("O Pica Miolos");
	});

	test("a row that names no venue at all is placed by the municipality in its title", async () => {
		const { deps: d } = harness({
			[LEIRIA_HUB]: `<html><body>
				${untagged("1111111111111111", "ORFEU E EURÍDICE - FESTIVAL DE ÓPERA DE ÓBIDOS 2026", "2026-10-04", "Leiria", "blueticket-leiria")}
				${untagged("2222222222222222", "CHIADO COMEDY CLUB | HUMOR NEGRO", "2026-10-04", "Leiria", "ticketline-leiria")}
				${untagged("3333333333333333", "Concerto no Marquês de Pombal", "2026-10-04", "Leiria", "ticketline-leiria")}
				</body></html>`,
			"https://www.nocartaz.pt/eventos/1111111111111111/":
				countryDetail("2026-10-04"),
			"https://www.nocartaz.pt/eventos/2222222222222222/":
				countryDetail("2026-10-04"),
			"https://www.nocartaz.pt/eventos/3333333333333333/":
				countryDetail("2026-10-04"),
		});
		const result = await scrape(d);
		expect(result.events.map((e) => e.slug)).toEqual([
			"nocartaz-1111111111111111",
		]);
		expect(must(result.events[0]).city).toBe("Óbidos");
	});

	test("a real out-of-district locality still wins over the title", async () => {
		const detailWithCity = (city: string, date: string) =>
			`<script type="application/ld+json">{"@type":"Event","name":"Detalhe","startDate":"${date}T21:00:00","location":{"name":"Sala","address":{"addressLocality":"${city}"}}}</script>`;
		const { deps: d } = harness({
			[LEIRIA_HUB]: `<html><body>${untagged("4444444444444444", "FESTIVAL DE ÓPERA DE ÓBIDOS 2026", "2026-10-05")}</body></html>`,
			"https://www.nocartaz.pt/eventos/4444444444444444/": detailWithCity(
				"Lisboa",
				"2026-10-05",
			),
		});
		expect((await scrape(d)).events).toEqual([]);
	});

	test("a dead secondary hub is reported, not fatal", async () => {
		const { deps: d } = harness(
			{
				[LEIRIA_HUB]: `<html><body>${untagged("5555555555555555", "Banda @ O Pica Miolos", "2026-10-06")}</body></html>`,
				"https://www.nocartaz.pt/eventos/5555555555555555/":
					countryDetail("2026-10-06"),
				[COIMBRA_HUB]: "ERR: 503 unavailable",
			},
			{ hubs: ["leiria", "coimbra"] },
		);
		const result = await scrape(d);
		expect(result.events.map((e) => e.slug)).toEqual([
			"nocartaz-5555555555555555",
		]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("503 unavailable");
	});
});
