import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { must } from "../test-helpers";
import { fingerprint, lisbonDay } from "./fingerprint";
import {
	LISTING_URL,
	maxPageFromHtml,
	mergeCardWithDetail,
	parseDetail,
	parseListing,
	scrape,
} from "./leiriagenda";
import { normalizeVenueName, slugify } from "./normalize";

const listingHtml = readFileSync(
	new URL("./__fixtures__/proximos.html", import.meta.url),
	"utf-8",
);
const detailHtml = readFileSync(
	new URL("./__fixtures__/event-detail.html", import.meta.url),
	"utf-8",
);
const TATTOO_URL = `${LISTING_URL.replace("/proximos-eventos", "")}/tattoo-artes`;

describe("parseListing (offline fixture)", () => {
	test("parses every event card (fixture has 28): none dropped", () => {
		const cards = parseListing(listingHtml);
		expect(cards.length).toBe(28);
	});

	test("tattoo-artes card: title, venue, category, url", () => {
		const card = parseListing(listingHtml).find(
			(c) => c.slug === "tattoo-artes",
		);
		expect(card).toBeDefined();
		expect(card?.title).toBe("Tattoo Artes");
		expect(card?.venueName).toBe("Centro Cultural Mercado de Sant'Ana");
		expect(card?.categories).toContain("Feira");
		expect(card?.url).toContain("/agenda/tattoo-artes");
		// Venue resolves (via normalizeVenueName) to the seed slug.
		expect(slugify(normalizeVenueName(card?.venueName ?? ""))).toBe(
			"mercado-de-santana",
		);
	});
});

describe("parseDetail (offline fixture)", () => {
	const detail = parseDetail(detailHtml, TATTOO_URL);

	test("parses sinopse description", () => {
		expect(detail.description).toContain("Tattoo Artes Leiria 2026");
	});

	test("isFree reads 'Entrada livre' from the Outras Informações block", () => {
		expect(detail.isFree).toBe(true);
		const silent = detailHtml.replace("Entrada livre", "Entrada no local");
		expect(silent).not.toBe(detailHtml);
		expect(parseDetail(silent, TATTOO_URL).isFree).toBeNull();
	});

	test("parses .hora into the correct epoch (2026-09-04 14:00 Lisbon)", () => {
		expect(detail.startAt).toBe(1788526800);
		expect(lisbonDay(must(detail.startAt))).toBe("2026-09-04");
	});

	test("parses end date 2026-09-06", () => {
		expect(detail.endAt).not.toBeNull();
		expect(lisbonDay(must(detail.endAt))).toBe("2026-09-06");
	});

	test("merged card+detail carries title, venue and categories", () => {
		const card = must(
			parseListing(listingHtml).find((c) => c.slug === "tattoo-artes"),
		);
		const merged = mergeCardWithDetail(card, detail);
		expect(merged.title).toBe("Tattoo Artes");
		expect(merged.venueName).toBe("Centro Cultural Mercado de Sant'Ana");
		// Detail carries richer, canonical categories (preferred over the card's).
		expect(merged.categories).toEqual(["Feira", "Eventos", "Cultura"]);
		expect(merged.isFree).toBe(true);
	});

	test("fingerprint is deterministic for the resolved venue", () => {
		const a = fingerprint(
			"Tattoo Artes",
			"Centro Cultural Mercado de Sant'Ana",
			must(detail.startAt),
		);
		const b = fingerprint(
			"Tattoo Artes",
			"mercado-de-santana",
			must(detail.startAt),
		);
		expect(a).toBe(b);
	});
});

describe("pagination discovery", () => {
	test("reads the last page number from listing html", () => {
		expect(maxPageFromHtml(listingHtml)).toBe(6);
	});
});

describe("scrape resilience (mock deps, offline)", () => {
	test("a dead detail page is counted, not fatal", async () => {
		const deadUrl = `${LISTING_URL.replace("/proximos-eventos", "")}/tattoo-artes`;
		const fetchText = async (url: string) => {
			if (url === LISTING_URL) return listingHtml;
			if (url === deadUrl) throw new Error(`GET ${url} -> HTTP 500`);
			return detailHtml;
		};
		const result = await scrape({ fetchText, sleep: async () => {} });
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("HTTP 500");
		expect(result.events.length).toBeGreaterThan(0);
		// The dead card's event is absent, everything else made it.
		expect(result.events.some((e) => e.url === deadUrl)).toBe(false);
	});
});
