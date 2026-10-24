import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lisbonDay } from "./fingerprint";
import {
	cityUrl,
	districtUrl,
	isoToEpoch,
	type ListingCard,
	parseDetail,
	parseListing,
	scrape,
	toRawEvent,
} from "./viralagenda";

const read = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8");

const districtHtml = read("va-district.html");
const concertsHtml = read("va-concerts.html");
const festivalHtml = read("va-fest.html");
const traditionHtml = read("va-trad.html");
const detailHtml = read("va-detail.html"); // Camané — Alcobaça
const detail3Html = read("va-detail3.html"); // Fuckup Nights — Leiria
const detail4Html = read("va-detail4.html"); // Festival de Ópera — Óbidos (multi-day)
const clubbingHtml = read("va-clubbing.html"); // Clubbing facet (Event + MusicEvent)
const venueHtml = read("va-venue.html"); // a venue page: NOT a card listing

const cardById = (cards: ListingCard[], id: string) => {
	const card = cards.find((c) => c.id === id);
	expect(card).toBeDefined();
	return card!;
};

describe("parseListing (offline fixtures)", () => {
	test("parses every card from each facet fixture", () => {
		expect(parseListing(districtHtml).length).toBe(20);
		expect(parseListing(concertsHtml).length).toBe(20);
		expect(parseListing(festivalHtml).length).toBe(12);
		expect(parseListing(traditionHtml).length).toBe(20);
	});

	test("cards expose url, title, venue and categories", () => {
		const card = cardById(parseListing(concertsHtml), "1831250");
		expect(card.title).toContain("Festas Moita da Roda");
		expect(card.url).toBe(
			"https://www.viralagenda.com/pt/events/1831250/festas-moita-da-roda-2026",
		);
		expect(card.categories.length).toBeGreaterThan(0);
		expect(card.imageUrl).toBeTruthy();
	});

	test("00:59 / N/D cards are flagged hasTime:false (placeholder)", () => {
		const beb = cardById(parseListing(concertsHtml), "1732846");
		expect(beb.hasTime).toBe(false);
		expect(beb.city).toBe("Leiria");
		expect(beb.venue).toBe("Teatro Miguel Franco");
	});

	test("district fixture mixes city nodes; Leiria appears", () => {
		const cards = parseListing(districtHtml);
		const cities = new Set(cards.flatMap((c) => c.cities));
		expect(cities.has("Leiria")).toBe(true);
		expect(cities.has("Pombal")).toBe(true);
		const leiriaCount = cards.filter((c) =>
			c.cities.some((x) => x.toLowerCase() === "leiria"),
		).length;
		expect(leiriaCount).toBe(3);
	});
});

describe("parseDetail (offline fixtures)", () => {
	test("Fuckup Nights (Leiria) JSON-LD resolves fully", () => {
		const d = parseDetail(detail3Html);
		expect(d).not.toBeNull();
		expect(d?.name).toBe("#3 Fuckup Nights Leiria");
		expect(d?.city).toBe("Leiria");
		expect(d?.venue).toBe("Mercado Municipal de Leiria");
		expect(d?.startDate).toBe("2026-09-03T17:00:00+01:00");
		expect(d?.endDate).toBe("2026-09-03T21:30:00+01:00");
		expect(d?.description).toContain("Fuckup");
	});

	test("Camané (Alcobaça) resolves to a non-Leiria locality", () => {
		const d = parseDetail(detailHtml);
		expect(d?.name).toBe("Camané");
		expect(d?.city).toBe("Alcobaça");
	});
});

describe("parseDetail: JSON-LD shapes (shared scanner)", () => {
	test("Festival de Ópera (Óbidos) keeps its multi-day range and district locality", () => {
		const d = parseDetail(detail4Html);
		expect(d?.name).toBe("Festival de Ópera de Óbidos");
		expect(d?.startDate).toBe("2026-09-05T20:00:00+01:00");
		expect(d?.endDate).toBe("2026-09-20T22:55:00+01:00");
		expect(d?.city).toBe("Óbidos");
		expect(d?.venue).toBe("Óbidos (vila)");
	});

	test("a MusicEvent page (Camané) is found, not only exact Event blocks", () => {
		expect(parseDetail(detailHtml)?.name).toBe("Camané");
	});

	test("array-wrapped and graph-wrapped event blocks resolve like bare ones", () => {
		const ld = (v: unknown) =>
			`<script type="application/ld+json">${JSON.stringify(v)}</script>`;
		const ev = {
			"@type": "TheaterEvent",
			name: "Peça",
			startDate: "2026-10-01T21:00:00+01:00",
			location: { name: "Teatro", address: { addressLocality: "Leiria" } },
		};
		for (const html of [
			ld(ev),
			ld([{ "@type": "Organization" }, ev]),
			ld({ "@graph": [{ "@type": "WebPage" }, ev] }),
		]) {
			const d = parseDetail(html);
			expect(d?.name).toBe("Peça");
			expect(d?.city).toBe("Leiria");
		}
	});

	test("a page with no event JSON-LD is null", () => {
		expect(parseDetail(venueHtml)).toBeNull();
	});
});

describe("clubbing facet fixture", () => {
	test("parses 20 cards, each tagged Clubbing or Concertos, dates intact", () => {
		const cards = parseListing(clubbingHtml);
		expect(cards).toHaveLength(20);
		expect(
			cards.every((c) =>
				c.categories.some((x) => x === "Clubbing" || x === "Concertos"),
			),
		).toBe(true);
		expect(cards.every((c) => c.dateStart !== null)).toBe(true);
		const first = cards[0];
		expect(first?.title).toBe("Extra Muralhas Leiria - Quinta 20");
		expect(first?.city).toBe("Leiria");
	});

	test("Leiria clubbing cards map to RawEvents via the listing-only fallback", () => {
		const events = parseListing(clubbingHtml)
			.map((c) => toRawEvent(c, null))
			.filter((e) => e !== null);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => e.startAt !== null)).toBe(true);
	});
});

describe("a venue page served instead of a listing", () => {
	test("parses to zero cards (no false positives from unrelated markup)", () => {
		expect(parseListing(venueHtml)).toEqual([]);
	});

	test("scrape() reports it as a zero-card failure, not a quiet day", async () => {
		const result = await scrape({
			fetchText: async () => venueHtml,
			sleep: async () => {},
			facets: ["concerts"],
		});
		expect(result.events).toEqual([]);
		expect(result.failures).toBeGreaterThan(0);
		expect(result.firstError).toContain("zero cards");
	});
});

describe("toRawEvent (Leiria city scope)", () => {
	test("Leiria card + Leiria detail -> dated event with detail fields", () => {
		const card = cardById(parseListing(concertsHtml), "1732846");
		const detail = parseDetail(detail3Html)!;
		const raw = toRawEvent(card, detail);
		expect(raw).not.toBeNull();
		// Detail is authoritative for title/venue/description…
		expect(raw!.title).toBe("#3 Fuckup Nights Leiria");
		expect(raw!.venueName).toBe("Mercado Municipal de Leiria");
		// …while the slug uses the CARD id (va-<id>).
		expect(raw!.slug).toBe("va-1732846");
		expect(raw!.city).toBe("Leiria");
		// startDate 2026-09-03T17:00+01:00 = 2026-09-03 17:00 Lisbon.
		expect(raw!.startAt).toBe(1788451200);
		expect(lisbonDay(raw!.startAt!)).toBe("2026-09-03");
	});

	test("00:59 placeholder card with no detail pins to the date at 00:00", () => {
		const card = cardById(parseListing(concertsHtml), "1732846");
		const raw = toRawEvent(card, null);
		expect(raw).not.toBeNull();
		expect(raw!.startAt).toBe(1788649200); // 2026-09-06 00:00 Lisbon
		expect(lisbonDay(raw!.startAt!)).toBe("2026-09-06");
	});

	test("district-scope card (Pombal) is now IN scope", () => {
		const pombal = parseListing(districtHtml).find(
			(c) => c.cities[0] === "Pombal",
		)!;
		// SLICE_6 scope correction: Pombal is a district municipality, so its
		// events are kept (city passes through to the venue row).
		const raw = toRawEvent(pombal, null);
		expect(raw).not.toBeNull();
		expect(raw?.city?.toLowerCase()).toContain("pombal");
	});
});

describe("scrape resilience (mock deps, offline)", () => {
	test("dead detail page is counted, Leiria-only events returned", async () => {
		const fetchText = async (url: string) => {
			if (url === districtUrl("concerts") || url === cityUrl("concerts")) {
				return concertsHtml;
			}
			if (url.includes("/1732846/")) {
				return detail3Html;
			}
			if (url.includes("/1831250/")) {
				throw new Error(`GET ${url} -> HTTP 500`);
			}
			return "<html><body></body></html>";
		};
		const result = await scrape({
			fetchText,
			sleep: async () => {},
			facets: ["concerts"],
		});
		// 20 cards, one dead detail → still 20 events (the dead one is kept via
		// the listing-only fallback), 1 failure counted.
		expect(result.events.length).toBe(20);
		expect(result.events.some((e) => e.slug === "va-1831250")).toBe(true);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("HTTP 500");
		expect(result.pagesFetched).toBeGreaterThan(0);
		// Every returned event is Leiria.
		expect(result.events.every((e) => e.city === "Leiria")).toBe(true);
		// The card whose detail resolved gets the detail fields.
		const merged = result.events.find((e) => e.slug === "va-1732846");
		expect(merged?.title).toBe("#3 Fuckup Nights Leiria");
	});
});

describe("S7 zero-card listing", () => {
	test("garbage markup on every facet is a counted failure, not a quiet day", async () => {
		const result = await scrape({
			fetchText: async () => "<html><body>Just a moment...</body></html>",
			sleep: async () => {},
			facets: ["concerts"],
		});
		expect(result.events.length).toBe(0);
		expect(result.failures).toBeGreaterThan(0);
		expect(result.firstError).toContain("zero cards");
	});

	test("a healthy listing does not add a zero-card failure", async () => {
		const result = await scrape({
			fetchText: async (url: string) =>
				url === districtUrl("concerts") || url === cityUrl("concerts")
					? concertsHtml
					: "<html><body></body></html>",
			sleep: async () => {},
			facets: ["concerts"],
		});
		expect(result.firstError ?? "").not.toContain("zero cards");
	});
});

describe("impossible dates (S2)", () => {
	const card = (over: Partial<ListingCard> = {}): ListingCard => ({
		id: "999",
		url: "https://www.viralagenda.com/pt/evento/999",
		title: "Concerto",
		city: "Leiria",
		cities: ["Leiria"],
		venue: "Teatro",
		categories: [],
		dateStart: "2026-02-30T21:00:00+00:00",
		dateEnd: null,
		hasTime: true,
		imageUrl: null,
		...over,
	});

	test("isoToEpoch returns null for 2026-02-30 instead of throwing", () => {
		expect(isoToEpoch("2026-02-30")).toBeNull();
		expect(isoToEpoch("2026-02-28")).not.toBeNull();
	});

	test("toRawEvent does not throw on an impossible card date", () => {
		expect(() => toRawEvent(card(), null)).not.toThrow();
		expect(
			toRawEvent(card({ dateStart: "2026-02-30", hasTime: false }), null)
				?.startAt,
		).toBeNull();
	});
});
