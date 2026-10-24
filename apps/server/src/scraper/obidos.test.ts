import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { municipalityOf } from "@events-tracker/api/places";
import { isLeiriaDistrict } from "./district";
import { toEpochInLisbon } from "./fingerprint";
import {
	categoryForTitle,
	ETN_SITEMAP,
	parseDate,
	parseDetail,
	parseEventSitemap,
	resolveVenue,
	scrape,
	slugFor,
	toRawEvent,
} from "./obidos";

const sitemapXml = readFileSync(
	new URL("./__fixtures__/obidos-sitemap.xml", import.meta.url),
	"utf-8",
);
const folioHtml = readFileSync(
	new URL("./__fixtures__/obidos-folio.html", import.meta.url),
	"utf-8",
);
const vilaNatalHtml = readFileSync(
	new URL("./__fixtures__/obidos-vila-natal.html", import.meta.url),
	"utf-8",
);
const gaeirasHtml = readFileSync(
	new URL("./__fixtures__/obidos-festa-das-gaeiras.html", import.meta.url),
	"utf-8",
);
const diaFreguesiaHtml = readFileSync(
	new URL("./__fixtures__/obidos-dia-da-freguesia.html", import.meta.url),
	"utf-8",
);

/** 2026-09-11 12:00 UTC — the live-run "now" (today). */
const NOW = Math.floor(Date.UTC(2026, 8, 11, 12, 0, 0) / 1000);

describe("parseEventSitemap (real etn-sitemap.xml fixture)", () => {
	test("extracts every /evento/ url with its lastmod watermark", () => {
		const entries = parseEventSitemap(sitemapXml);
		expect(entries.length).toBe(95);
		const folio = entries.find((e) =>
			e.url.includes("folio-festival-literario-internacional-de-obidos"),
		);
		expect(folio).toBeDefined();
		expect(folio?.url.startsWith("https://agenda.obidos.pt/evento/")).toBe(
			true,
		);
		expect(folio?.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(
			entries.every((e) =>
				e.url.startsWith("https://agenda.obidos.pt/evento/"),
			),
		).toBe(true);
	});
});

describe("parseDetail (real detail-page fixtures)", () => {
	test("FOLIO: clean title, range date, venue, description, poster", () => {
		const d = parseDetail(folioHtml);
		expect(d.title).toBe("FÓLIO – Festival Literário Internacional de Óbidos");
		expect(d.dateText).toBe("8 de Outubro, 2026 - 18 de Outubro, 2026");
		expect(d.venue).toBe("Vila de Óbidos");
		expect(d.imageUrl).toMatch(
			/^https:\/\/agenda\.obidos\.pt\/wp-content\/uploads\//,
		);
		expect(d.description?.length).toBeGreaterThan(40);
		expect(d.description).toMatch(/literatura/);
	});

	test("Óbidos Vila Natal: cross-year long-running range", () => {
		const d = parseDetail(vilaNatalHtml);
		expect(d.title).toBe("Óbidos Vila Natal");
		expect(d.dateText).toBe("27 de Novembro, 2026 - 3 de Janeiro, 2027");
		expect(d.venue).toBe("Cerca do Castelo");
	});

	test("Festa das Gaeiras: comma venue (freguesia, Óbidos)", () => {
		const d = parseDetail(gaeirasHtml);
		expect(d.title).toBe("Festa das Gaeiras");
		expect(d.dateText).toBe("8 de Setembro, 2026 - 12 de Setembro, 2026");
		expect(d.venue).toBe("Largo de São Marcos, Gaeiras");
	});

	test("Dia da Freguesia: single-day, freguesia venue, no comma", () => {
		const d = parseDetail(diaFreguesiaHtml);
		expect(d.title).toBe("Dia da Freguesia – A-dos-Negros");
		expect(d.dateText).toBe("5 de Julho, 2026");
		expect(d.venue).toBe("A dos Negros");
	});
});

describe("parseDate", () => {
	test("single day with year", () => {
		expect(parseDate("13 de Junho, 2026")).toEqual({
			startYear: 2026,
			startMonth: 6,
			startDay: 13,
			endYear: 2026,
			endMonth: 6,
			endDay: 13,
		});
	});

	test("same-month range", () => {
		expect(parseDate("8 de Outubro, 2026 - 18 de Outubro, 2026")).toEqual({
			startYear: 2026,
			startMonth: 10,
			startDay: 8,
			endYear: 2026,
			endMonth: 10,
			endDay: 18,
		});
	});

	test("cross-year range", () => {
		expect(parseDate("27 de Novembro, 2026 - 3 de Janeiro, 2027")).toEqual({
			startYear: 2026,
			startMonth: 11,
			endMonth: 1,
			startDay: 27,
			endYear: 2027,
			endDay: 3,
		});
	});

	test("accent marks (Março) normalize", () => {
		expect(parseDate("4 de Março, 2026")?.startMonth).toBe(3);
	});

	test("unparseable → null", () => {
		expect(parseDate("A definir")).toBeNull();
		expect(parseDate("5 e 6 de Junho")).toBeNull();
	});
});

describe("resolveVenue", () => {
	test("unknown 'A definir' falls back to Óbidos placeholder", () => {
		expect(resolveVenue("A definir")).toEqual({
			venueName: "Óbidos",
			city: "Óbidos",
		});
	});

	test("Óbidos freguesia city becomes the city (recognition gap closed)", () => {
		const r = resolveVenue("Largo de São Marcos, Gaeiras");
		expect(r.venueName).toBe("Largo de São Marcos, Gaeiras");
		// Gaeiras is an Óbidos freguesia and the shared place table knows it, so
		// the specific place wins as before — the concelho facet folds it back.
		expect(r.city).toBe("Gaeiras");
		expect(municipalityOf(r.city)).toBe("Óbidos");
		expect(isLeiriaDistrict(r.city)).toBe(true);
	});

	test("a freguesia the place table cannot place keeps the concelho", () => {
		// Amoreira is an Óbidos freguesia whose name repeats across municípios,
		// so the table leaves it unplaced and Óbidos stands.
		const r = resolveVenue("Adro, Amoreira");
		expect(r.city).toBe("Óbidos");
	});

	test("recognized concelho after comma becomes the city", () => {
		expect(resolveVenue("Amoreira, Óbidos").city).toBe("Óbidos");
	});

	test("foreign concelho is surfaced so the gate can drop it", () => {
		const r = resolveVenue("Teatro, Lisboa");
		expect(r.city).toBe("Lisboa");
		expect(isLeiriaDistrict(r.city)).toBe(false);
	});
});

describe("toRawEvent", () => {
	test("FOLIO (future) → dated, in-district RawEvent, ob- slug", () => {
		const raw = toRawEvent(parseDetail(folioHtml), folioUrl(), NOW);
		expect(raw).not.toBeNull();
		expect(raw?.title).toBe(
			"FÓLIO – Festival Literário Internacional de Óbidos",
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 10, 8));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 10, 18, 23, 59));
		expect(raw?.dateText).toBeNull();
		expect(raw?.venueName).toBe("Vila de Óbidos");
		expect(raw?.city).toBe("Óbidos");
		expect(raw?.slug).toBe(
			"ob-folio-festival-literario-internacional-de-obidos",
		);
		expect(raw?.categories).toEqual(["Festivais"]);
		expect(raw?.description).toBeTruthy();
		expect(raw?.imageUrl).toMatch(/^https:\/\//);
		expect(isLeiriaDistrict(raw?.city)).toBe(true);
	});

	test("Óbidos Vila Natal keeps its real cross-year range", () => {
		const raw = toRawEvent(
			parseDetail(vilaNatalHtml),
			"https://agenda.obidos.pt/evento/obidos-vila-natal/",
			NOW,
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 11, 27));
		expect(raw?.endAt).toBe(toEpochInLisbon(2027, 1, 3, 23, 59));
	});

	test("past single-day festa → null (drop, not rolled forward)", () => {
		// Dia da Freguesia, 5 de Julho 2026 < now (Sep 11) → dropped.
		const raw = toRawEvent(
			parseDetail(diaFreguesiaHtml),
			"https://agenda.obidos.pt/evento/dia-da-freguesia-a-dos-negros/",
			NOW,
		);
		expect(raw).toBeNull();
	});

	test("undated text keeps dateText and null epochs", () => {
		const raw = toRawEvent(
			{
				title: "Oficina",
				dateText: "A definir",
				venue: "Espaço MyMachine",
				description: null,
				imageUrl: null,
			},
			"https://agenda.obidos.pt/evento/oficina/",
			NOW,
		);
		expect(raw?.startAt).toBeNull();
		expect(raw?.endAt).toBeNull();
		expect(raw?.dateText).toBe("A definir");
	});
});

describe("isFree", () => {
	test("comes from the title and description wording, else null", () => {
		const page = parseDetail(folioHtml);
		const free = toRawEvent(
			{ ...page, description: "Programa com entrada gratuita." },
			folioUrl(),
			NOW,
		);
		expect(free?.isFree).toBe(true);
		const silent = toRawEvent(
			{ ...page, description: "Programa completo." },
			folioUrl(),
			NOW,
		);
		expect(silent?.isFree).toBeNull();
	});
});

describe("gate (tests run via a mock isInScope like production wiring)", () => {
	test("an in-district event passes isLeiriaDistrict on its city", () => {
		const raw = toRawEvent(parseDetail(folioHtml), folioUrl(), NOW);
		expect(raw).not.toBeNull();
		expect(isLeiriaDistrict(raw?.city)).toBe(true);
	});

	test("a foreign-concelho venue fails the district gate", () => {
		const raw = toRawEvent(
			{
				title: "Espetáculo (Lisboa venue)",
				dateText: "1 de Outubro, 2026",
				venue: "Teatro, Lisboa",
				description: null,
				imageUrl: null,
			},
			"https://agenda.obidos.pt/evento/espetaculo/",
			NOW,
		);
		expect(raw).not.toBeNull();
		expect(isLeiriaDistrict(raw?.city)).toBe(false);
	});
});

describe("S7 scrape: discovery failures are counted", () => {
	const mk = (fetchText: (u: string) => Promise<string>) => ({
		fetchText,
		sleep: async () => {},
		loadState: () => ({ lastmod: {} }),
		saveState: () => {},
		now: NOW,
	});

	test("a dead sitemap fetch is failures: 1 with the url in the message", async () => {
		const res = await scrape(
			mk(async () => {
				throw new Error("HTTP 503");
			}),
		);
		expect(res.events).toEqual([]);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain(ETN_SITEMAP);
		expect(res.firstError).toContain("HTTP 503");
	});

	test("a sitemap that parses to zero urls is a failure", async () => {
		const res = await scrape(mk(async () => "<html>Just a moment...</html>"));
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("zero event urls");
	});

	test("an unchanged watermark (zero changed urls) is NOT a failure", async () => {
		const lastmod = Object.fromEntries(
			parseEventSitemap(sitemapXml).map((e) => [e.url, e.lastmod]),
		);
		const res = await scrape({
			...mk(async () => sitemapXml),
			loadState: () => ({ lastmod }),
		});
		expect(res.failures).toBe(0);
		expect(res.events).toEqual([]);
		expect(res.discovered).toBeGreaterThan(0);
	});
});

describe("slugFor", () => {
	test("ob- prefix from the event slug", () => {
		expect(
			slugFor(
				"https://agenda.obidos.pt/evento/folio-festival-literario-internacional-de-obidos/",
			),
		).toBe("ob-folio-festival-literario-internacional-de-obidos");
	});
});

describe("categoryForTitle", () => {
	test("falls into the expected raw category buckets", () => {
		expect(categoryForTitle("Exposição Coletiva")).toBe("Exposições");
		expect(categoryForTitle("FOLIO – Festival Literário")).toBe("Festivais");
		expect(categoryForTitle("Mercado Medieval de Óbidos")).toBe(
			"Mercados e Feiras",
		);
		expect(categoryForTitle("Festa das Gaeiras")).toBe("Tradição");
		expect(categoryForTitle("ATELIÊ DE RISCADORES")).toBe("Oficinas");
	});
});

function folioUrl(): string {
	return "https://agenda.obidos.pt/evento/folio-festival-literario-internacional-de-obidos/";
}

describe("S13 scrape(): happy path and a dead detail page", () => {
	const BASE = "https://agenda.obidos.pt/evento";
	const FOLIO = `${BASE}/folio-festival-literario-internacional-de-obidos/`;
	const NATAL = `${BASE}/obidos-vila-natal/`;
	const PAST = `${BASE}/dia-da-freguesia-a-dos-negros/`;
	const DEAD = `${BASE}/pagina-morta/`;
	const pages = new Map([
		[FOLIO, folioHtml],
		[NATAL, vilaNatalHtml],
		[PAST, diaFreguesiaHtml],
	]);
	const sitemap = `<urlset>${[FOLIO, NATAL, PAST, DEAD]
		.map(
			(u) =>
				`<url><loc><![CDATA[${u}]]></loc><lastmod><![CDATA[2026-09-08T10:00:00+00:00]]></lastmod></url>`,
		)
		.join("")}</urlset>`;

	function run(initial: Record<string, string> = {}) {
		const fetched: string[] = [];
		const saved: { lastmod: Record<string, string> }[] = [];
		const sleeps: number[] = [];
		const promise = scrape(
			{
				fetchText: async (url) => {
					fetched.push(url);
					if (url === ETN_SITEMAP) {
						return sitemap;
					}
					const html = pages.get(url);
					if (!html) {
						throw new Error(`GET ${url} -> HTTP 404`);
					}
					return html;
				},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				loadState: () => ({ lastmod: initial }),
				saveState: (s) => {
					saved.push(s);
				},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		return { promise, fetched, saved, sleeps };
	}

	test("emits the dated in-district events, drops the past one, counts the dead page", async () => {
		const { promise, saved, sleeps } = run();
		const res = await promise;
		expect(res.events.map((e) => e.slug).sort()).toEqual([
			"ob-folio-festival-literario-internacional-de-obidos",
			"ob-obidos-vila-natal",
		]);
		expect(res.discovered).toBe(4);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("pagina-morta");
		// sitemap + 3 good details are "pages fetched"; the dead one is not
		expect(res.pagesFetched).toBe(4);
		// every request, the failed one included, is preceded by a polite delay
		expect(sleeps).toHaveLength(5);
		expect(sleeps.every((ms) => ms >= 350 && ms <= 649)).toBe(true);
		// watermark: saved only when the runner commits after ingest (C7);
		// fetched urls are recorded (the past one included: a deliberate
		// skip), the dead one is not (retried next run)
		expect(saved).toHaveLength(0);
		res.commit?.();
		expect(saved).toHaveLength(1);
		expect(Object.keys(saved[0]?.lastmod ?? {}).sort()).toEqual(
			[FOLIO, NATAL, PAST].sort(),
		);
	});

	test("a second run with the saved watermark fetches only the sitemap and the dead url", async () => {
		const watermark = Object.fromEntries(
			[FOLIO, NATAL, PAST].map((u) => [u, "2026-09-08T10:00:00+00:00"]),
		);
		const { promise, fetched } = run(watermark);
		const res = await promise;
		expect(fetched).toEqual([ETN_SITEMAP, DEAD]);
		expect(res.events).toEqual([]);
		expect(res.failures).toBe(1);
	});
});
