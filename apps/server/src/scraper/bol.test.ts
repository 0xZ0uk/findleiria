import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	buildRawEvents,
	LISTING_URLS,
	parseDetailSessions,
	parseListingLinks,
	scrape,
} from "./bol";
import { toEpochInLisbon } from "./fingerprint";

const listingHtml = readFileSync(
	new URL("./__fixtures__/bol.html", import.meta.url),
	"utf-8",
);
const detailHtml = readFileSync(
	new URL("./__fixtures__/bol-detail.html", import.meta.url),
	"utf-8",
);

describe("parseListingLinks (offline fixture)", () => {
	test("extracts every unique event id (fixture has 60 unique links)", () => {
		const links = parseListingLinks(listingHtml);
		expect(links.length).toBe(60);
		// ids are unique (dedup by id)
		const ids = new Set(links.map((l) => l.id));
		expect(ids.size).toBe(links.length);
	});

	test("venue slug is the LAST hyphen segment; event slug is the middle", () => {
		const links = parseListingLinks(listingHtml);
		expect(links.length).toBeGreaterThan(0);

		const viana = links.find((l) => l.id === 176997);
		expect(viana?.venueSlug).toBe("c_c_viana_do_castelo");
		expect(viana?.eventSlug).toBe(
			"antonio_zambujo_oracao_ao_tempo_viana_do_castelo",
		);
		expect(viana?.url).toContain("/Comprar/Bilhetes/176997");

		// multi-token venue slug splits cleanly off the event slug
		const loz = links.find((l) => l.id === 168837);
		expect(loz?.venueSlug).toBe("coliseu_de_lisboa");
		expect(loz?.eventSlug).toBe("iolanda");

		const aula = links.find((l) => l.id === 175339);
		expect(aula?.venueSlug).toBe("aula_magna");
	});

	test("a listing that repeats a link is still deduped by id", () => {
		const links = parseListingLinks(
			listingHtml.replace(
				"/Comprar/Bilhetes/168837-iolanda-coliseu_de_lisboa/",
				"/Comprar/Bilhetes/168837-iolanda-coliseu_de_lisboa/",
			),
		);
		const dup = links.filter((l) => l.id === 168837);
		expect(dup.length).toBe(1);
	});
});

describe("parseDetailSessions (offline fixture)", () => {
	const sessions = parseDetailSessions(detailHtml, "https://x/176997");

	test("parses the single session date (2026-12-05) with its 21:30 time", () => {
		expect(sessions.length).toBe(1);
		expect(sessions[0]?.hasTime).toBe(true);
		// 2026-12-05 21:30 Europe/Lisbon
		expect(sessions[0]?.startAt).toBe(toEpochInLisbon(2026, 12, 5, 21, 30));
	});

	test("epoch is exact (Europe/Lisbon, December 2026)", () => {
		expect(sessions[0]?.startAt).toBe(1796506200);
	});
});

describe("buildRawEvents (offline fixture)", () => {
	test("merges a listing card + detail into one RawEvent per session", () => {
		const card = {
			id: 176997,
			url: "https://www.bol.pt/Comprar/Bilhetes/176997-antonio_zambujo_oracao_ao_tempo_viana_do_castelo-c_c_viana_do_castelo/",
			eventSlug: "antonio_zambujo_oracao_ao_tempo_viana_do_castelo",
			venueSlug: "c_c_viana_do_castelo",
		};
		const events = buildRawEvents(card, detailHtml);
		expect(events.length).toBe(1);
		expect(events[0]?.title).toBe(
			"Antonio Zambujo Oracao Ao Tempo Viana Do Castelo",
		);
		// Pre-filter: Viana do Castelo is NOT Leiria → city null.
		expect(events[0]?.city).toBeNull();
		expect(events[0]?.venueName).toBe("C C Viana Do Castelo");
		expect(events[0]?.categories).toEqual([]);
		expect(events[0]?.dateText).toBeNull();
		expect(events[0]?.description).toBeNull();
		expect(events[0]?.startAt).toBe(1796506200);
		expect(events[0]?.endAt).toBeNull();
		expect(events[0]?.url).toBe(card.url);
	});

	test("city is null at raw level — resolved at ingest (district scope)", () => {
		const card = {
			id: 1,
			url: "https://x/Comprar/Bilhetes/1-fake-teatro_miguel_franco-teatro_miguel_franco/",
			eventSlug: "fake",
			venueSlug: "teatro_miguel_franco",
		};
		const events = buildRawEvents(card, detailHtml);
		// SLICE_6: BOL listings are district-filtered upstream (the `10`
		// segment); raw events carry city=null and ingest resolves it from
		// the venue name. No city-scope gate here anymore.
		expect(events[0]?.city).toBeNull();
	});
});

const sessionDetail = (dateParts: string[], times: string[]) => `
<div class="datas-sessoes"><div class="datas">
${dateParts.map((d) => `<div class="sessao"><div class="ano">2026</div><div class="mes">dez</div><div class="dia">${d}</div></div>`).join("")}
</div><div class="proxima-sessao">${times.map((t) => `<span>${t}</span>`).join("")}</div></div>`;

describe("S5 same-day sessions get distinct slugs", () => {
	const card = {
		id: 7,
		url: "https://www.bol.pt/Comprar/Bilhetes/7-peca-teatro_x/",
		eventSlug: "peca",
		venueSlug: "teatro_x",
	};

	test("earliest keeps the bare slug, later same-day session is suffixed", () => {
		const events = buildRawEvents(
			card,
			sessionDetail(["05", "05"], ["05 dez 2026 21:30", "05 dez 2026 18:30"]),
		);
		expect(events.length).toBe(2);
		const bySlug = new Map(events.map((e) => [e.slug, e.startAt]));
		expect(bySlug.get("peca")).toBe(toEpochInLisbon(2026, 12, 5, 18, 30));
		expect(bySlug.get("peca-2130")).toBe(toEpochInLisbon(2026, 12, 5, 21, 30));
	});

	test("sessions on different days all keep the bare slug", () => {
		const events = buildRawEvents(
			card,
			sessionDetail(["05", "06"], ["05 dez 2026 21:30", "06 dez 2026 21:30"]),
		);
		expect(events.map((e) => e.slug)).toEqual(["peca", "peca"]);
	});

	test("a single session keeps exactly the pre-existing slug", () => {
		const events = buildRawEvents(card, detailHtml);
		expect(events.map((e) => e.slug)).toEqual(["peca"]);
	});
});

describe("scrape (mock deps, offline)", () => {
	const deps = (fetchText: (url: string) => Promise<string>) => ({
		fetchText,
		sleep: async () => {},
	});

	test("non-Leiria-city venues from the district listing are kept (no venue gate)", async () => {
		const link = (id: number, slug: string) =>
			`<a href="/Comprar/Bilhetes/${id}-${slug}/">x</a>`;
		const listing = `<html><body>${link(1, "show_a-cine_teatro_caldas")}${link(2, "show_b-teatro_pombal")}</body></html>`;
		const result = await scrape(
			deps(async (url) => (LISTING_URLS.includes(url) ? listing : detailHtml)),
		);
		expect(result.failures).toBe(0);
		expect(new Set(result.events.map((e) => e.venueName))).toEqual(
			new Set(["Cine Teatro Caldas", "Teatro Pombal"]),
		);
		expect([...result.venueSlugs].sort()).toEqual([
			"cine_teatro_caldas",
			"teatro_pombal",
		]);
	});

	test("a failed listing fetch is counted with a descriptive error", async () => {
		const link = `<a href="/Comprar/Bilhetes/1-show_a-teatro_x/">x</a>`;
		const result = await scrape(
			deps(async (url) => {
				if (url === LISTING_URLS[0]) throw new Error("HTTP 503");
				return LISTING_URLS.includes(url) ? `<html>${link}</html>` : detailHtml;
			}),
		);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("listing");
		expect(result.firstError).toContain("HTTP 503");
		expect(result.events.length).toBeGreaterThan(0);
	});

	test("S13: real listing fixture, one detail fetch per unique link, none failing", async () => {
		const unique = new Map(
			parseListingLinks(listingHtml).map((l) => [l.id, l] as const),
		);
		const fetched: string[] = [];
		const result = await scrape(
			deps(async (url) => {
				fetched.push(url);
				return LISTING_URLS.includes(url) ? listingHtml : detailHtml;
			}),
		);
		expect(unique.size).toBeGreaterThan(0);
		expect(result.failures).toBe(0);
		expect(result.firstError).toBeNull();
		// listings are deduped by event id across LISTING_URLS, then one detail each
		expect(fetched.length).toBe(LISTING_URLS.length + unique.size);
		expect(result.events.length).toBeGreaterThanOrEqual(unique.size);
		expect(result.events.every((e) => e.startAt != null)).toBe(true);
	});

	test("S13: a detail fetch that throws is counted; the other events still come out", async () => {
		const link = (id: number, slug: string) =>
			`<a href="/Comprar/Bilhetes/${id}-${slug}/">x</a>`;
		const listing = `<html>${link(1, "show_a-teatro_x")}${link(2, "show_b-teatro_y")}${link(3, "show_c-teatro_z")}</html>`;
		const result = await scrape(
			deps(async (url) => {
				if (LISTING_URLS.includes(url)) {
					return listing;
				}
				if (url.includes("/2-")) {
					throw new Error("HTTP 500");
				}
				return detailHtml;
			}),
		);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("HTTP 500");
		expect(new Set(result.events.map((e) => e.venueName))).toEqual(
			new Set(["Teatro X", "Teatro Z"]),
		);
		expect([...result.venueSlugs].sort()).toEqual([
			"teatro_x",
			"teatro_y",
			"teatro_z",
		]);
	});

	test("listings that parse to zero links are a failure", async () => {
		const result = await scrape(
			deps(async () => "<html><body>checkpoint</body></html>"),
		);
		expect(result.events.length).toBe(0);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("zero event links");
	});
});
