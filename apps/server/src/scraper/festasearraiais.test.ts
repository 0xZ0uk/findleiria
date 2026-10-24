import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { isLeiriaDistrict } from "./district";
import {
	categoryForTitle,
	districtScore,
	MAX_REQUESTS,
	parseDetailLd,
	parseEventSitemap,
	parseSitemapIndex,
	rankCandidates,
	scrape,
	toRawEvent,
} from "./festasearraiais";
import { toEpochInLisbon } from "./fingerprint";

const detail2024 = readFileSync(
	new URL(
		"./__fixtures__/festasearraiais-tremoceira-2024.html",
		import.meta.url,
	),
	"utf-8",
);
const detail2026 = readFileSync(
	new URL(
		"./__fixtures__/festasearraiais-vestiaria-2026.html",
		import.meta.url,
	),
	"utf-8",
);
const sitemapXml = readFileSync(
	new URL("./__fixtures__/festasearraiais-sitemap.xml", import.meta.url),
	"utf-8",
);

describe("parseSitemapIndex", () => {
	test("extracts the sitemap-eventos sub-sitemaps only", () => {
		const subs = parseSitemapIndex(
			`<sitemapindex>
				<sitemap><loc>https://festasearraiais.pt/sitemap-static.xml</loc></sitemap>
				<sitemap><loc>https://festasearraiais.pt/sitemap-eventos.xml</loc></sitemap>
				<sitemap><loc>https://festasearraiais.pt/sitemap-eventos-2.xml</loc></sitemap>
				<sitemap><loc>https://festasearraiais.pt/sitemap-distritos.xml</loc></sitemap>
			</sitemapindex>`,
		);
		expect(subs).toEqual([
			"https://festasearraiais.pt/sitemap-eventos.xml",
			"https://festasearraiais.pt/sitemap-eventos-2.xml",
		]);
	});
});

describe("parseEventSitemap (real fixture, 4103 urls)", () => {
	test("parses every url block with its lastmod", () => {
		const entries = parseEventSitemap(sitemapXml);
		expect(entries.length).toBe(4103);
		// Tremoceira is NOT in the sitemap (the site skipped it — the gap
		// that motivated SLICE_7). A September festa that IS there:
		const barosa = entries.find((e) => e.url.includes("barosa"));
		expect(barosa?.url).toContain("festa-em-honra-de-s-mateus-2026-barosa");
		expect(barosa?.lastmod.length).toBeGreaterThan(0);
	});
});

describe("S7 scrape: discovery failures are counted", () => {
	const mk = (
		fetchText: (u: string) => Promise<string>,
		seen: string[] = [],
	) => ({
		fetchText,
		sleep: async () => {},
		loadState: () => ({ seen }),
		saveState: () => {},
		now: 0,
	});
	const index =
		"<sitemapindex><sitemap><loc>https://festasearraiais.pt/sitemap-eventos.xml</loc></sitemap></sitemapindex>";

	test("a dead sitemap fetch is failures: 1 with a descriptive error", async () => {
		const res = await scrape(
			mk(async () => {
				throw new Error("HTTP 503");
			}),
		);
		expect(res.events).toEqual([]);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("sitemap discovery failed");
		expect(res.firstError).toContain("HTTP 503");
	});

	test("sitemaps that parse to zero urls are a failure", async () => {
		const res = await scrape(
			mk(async (u) =>
				u.endsWith("sitemap.xml") ? index : "<html>blocked</html>",
			),
		);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("zero event urls");
	});

	test("everything already seen (zero NEW urls) is NOT a failure", async () => {
		const res = await scrape(
			mk(
				async (u) => (u.endsWith("sitemap.xml") ? index : sitemapXml),
				parseEventSitemap(sitemapXml).map((e) => e.url),
			),
		);
		expect(res.failures).toBe(0);
		expect(res.discovered).toBeGreaterThan(0);
	});
});

describe("parseDetailLd (real pages)", () => {
	test("picks the Event block out of the @graph page", () => {
		const ld = parseDetailLd(detail2024);
		expect(ld?.name).toBe("Festas da Tremoceira 2024 - Porto de Mós");
		expect(ld?.startDate).toBe("2024-08-30");
	});

	test("returns null when no Event JSON-LD exists", () => {
		expect(parseDetailLd("<html><body>nope</body></html>")).toBeNull();
	});
});

describe("toRawEvent (real JSON-LD)", () => {
	test("Tremoceira 2024: inclusive endDate lands at Sep 1 23:59:59 Lisbon", () => {
		const ld = parseDetailLd(detail2024);
		expect(ld).not.toBeNull();
		const raw = toRawEvent(ld as Record<string, unknown>, "https://x");
		expect(raw?.title).toBe("Festas da Tremoceira 2024 - Porto de Mós");
		expect(raw?.startAt).toBe(toEpochInLisbon(2024, 8, 30));
		// endDate 2024-09-02 is INCLUSIVE → end of last day = Sep 2 00:00 − 1s
		expect(raw?.endAt).toBe(toEpochInLisbon(2024, 9, 2) + 86_399);
		expect(raw?.venueName).toBe("Tremoceira, Pedreiras");
		expect(raw?.city).toBe("Porto de Mós");
		expect(raw?.slug).toBe("fe-https:.x");
		expect(raw?.dateText).toBeNull();
		expect(raw?.categories).toEqual(["Tradição"]);
		expect(raw?.imageUrl).toContain("cdn.festasearraiais.pt");
	});

	test("Vestiaria 2026 (ongoing): 28 Aug → 8 Sep inclusive end", () => {
		const ld = parseDetailLd(detail2026);
		const raw = toRawEvent(ld as Record<string, unknown>, "https://y");
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 8, 28));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 8) + 86_399);
		expect(raw?.city).toBe("Alcobaça");
	});

	test("single-day event without endDate pins end = start", () => {
		const raw = toRawEvent(
			{
				name: "Feira do Livro 2026",
				startDate: "2026-10-03",
				location: {
					name: "Jardim do Castelo",
					address: { addressLocality: "Leiria" },
				},
			},
			"https://festasearraiais.pt/eventos/feira-do-livro-2026-12345",
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 10, 3));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 10, 3));
	});

	test("category heuristic: feira/festival/mercado/default", () => {
		expect(categoryForTitle("Feira dos Enchidos 2026")).toBe(
			"Mercados e Feiras",
		);
		expect(categoryForTitle("Mercado Barroco 2026")).toBe("Mercados e Feiras");
		expect(categoryForTitle("Festival de Folclore 2026")).toBe("Festivais");
		expect(categoryForTitle("Festas da Vila 2026")).toBe("Tradição");
	});
});

describe("parseDetailLd (shared JSON-LD scanner)", () => {
	const wrap = (json: unknown) =>
		`<script type="application/ld+json">${JSON.stringify(json)}</script>`;

	test("accepts Event subtypes, which the exact-Event scan used to miss", () => {
		const ld = parseDetailLd(
			wrap({ "@type": "MusicEvent", name: "Arraial", startDate: "2026-08-01" }),
		);
		expect(ld?.name).toBe("Arraial");
	});

	test("accepts an array root and an array-valued @type", () => {
		const ld = parseDetailLd(
			wrap([
				{ "@type": "Organization", name: "Org" },
				{
					"@type": ["Thing", "Festival"],
					name: "Festa",
					startDate: "2026-08-01",
				},
			]),
		);
		expect(ld?.name).toBe("Festa");
	});

	test("a page with only non-event JSON-LD is null", () => {
		expect(parseDetailLd(wrap({ "@type": "WebSite", name: "x" }))).toBeNull();
	});
});

describe("S9 district-first request budget", () => {
	const entries = parseEventSitemap(sitemapXml);
	const D = entries.filter((e) => districtScore(e.url) > 0).length;

	test("districtScore reads the place after the year, not the devotion", () => {
		const u = (slug: string) => `https://festasearraiais.pt/eventos/${slug}`;
		// the place is the whole tail: strongest evidence
		expect(
			districtScore(u("festa-em-honra-de-s-sebastiao-2026-cortes-8626")),
		).toBe(2);
		expect(districtScore(u("carnaval-2026-nazare-8565"))).toBe(2);
		// a district parish name inside a longer, non-district place: weak evidence
		expect(
			districtScore(
				u("festas-em-honra-de-nossa-senhora-da-paz-2025-vilar-formoso-7747"),
			),
		).toBe(1);
		// "Graça" is a district parish, but here it is only the devotion
		expect(
			districtScore(
				u("festa-em-honra-de-nossa-senhora-da-graca-2026-ataija-de-cima-8802"),
			),
		).toBe(0);
		expect(districtScore(u("aldeia-natal-do-seixal-2025-8505"))).toBe(0);
		// multi-word places, accents folded
		expect(districtScore(u("festas-2026-caldas-da-rainha-9999"))).toBe(2);
	});

	test("the fixture has a meaningful district subset, far smaller than the sitemap", () => {
		expect(entries).toHaveLength(4103);
		expect(D).toBeGreaterThan(150);
		expect(D).toBeLessThan(MAX_REQUESTS);
	});

	test("rankCandidates puts every district url first and drops nothing", () => {
		const ranked = rankCandidates(entries);
		expect(ranked).toHaveLength(entries.length);
		expect(new Set(ranked.map((e) => e.url)).size).toBe(entries.length);
		const scores = ranked.map((e) => districtScore(e.url));
		expect(scores.slice(0, D).every((s) => s > 0)).toBe(true);
		expect(scores.slice(D).every((s) => s === 0)).toBe(true);
		// strongest evidence leads, and within a tier the newest lastmod leads
		expect(scores[0]).toBe(2);
		for (let i = 1; i < ranked.length; i++) {
			const a = ranked[i - 1];
			const b = ranked[i];
			if (a && b && scores[i - 1] === scores[i]) {
				expect(a.lastmod >= b.lastmod).toBe(true);
			}
		}
	});

	test("a lastmod-only order would have spent the cap mostly outside the district", () => {
		const budget = MAX_REQUESTS - 2; // the index and the sitemap are requests too
		const byLastmod = [...entries].sort((a, b) =>
			b.lastmod.localeCompare(a.lastmod),
		);
		const before = byLastmod
			.slice(0, budget)
			.filter((e) => districtScore(e.url) > 0).length;
		const after = rankCandidates(entries)
			.slice(0, budget)
			.filter((e) => districtScore(e.url) > 0).length;
		expect(after).toBe(D);
		expect(after).toBeGreaterThan(before);
	});

	test("scrape() fetches district urls first and still reaches the rest of the cap", async () => {
		const index =
			"<sitemapindex><sitemap><loc>https://festasearraiais.pt/sitemap-eventos.xml</loc></sitemap></sitemapindex>";
		const detailUrls: string[] = [];
		const saved: { seen: string[] }[] = [];
		const res = await scrape({
			fetchText: async (u) => {
				if (u.endsWith("/sitemap.xml")) {
					return index;
				}
				if (u.endsWith("sitemap-eventos.xml")) {
					return sitemapXml;
				}
				detailUrls.push(u);
				return detail2026;
			},
			sleep: async () => {},
			loadState: () => ({ seen: [] }),
			saveState: (s) => {
				saved.push(s);
			},
			now: 0,
		});
		expect(detailUrls).toHaveLength(MAX_REQUESTS - 2);
		const first = detailUrls.slice(0, D);
		expect(first.every((u) => districtScore(u) > 0)).toBe(true);
		// the priority is not a filter: out-of-district urls fill the rest
		expect(detailUrls.slice(D).every((u) => districtScore(u) === 0)).toBe(true);
		expect(detailUrls.length).toBeGreaterThan(D);
		expect(res.discovered).toBe(4103);
		res.commit?.();
		expect(saved[0]?.seen).toHaveLength(MAX_REQUESTS - 2);
	});
});

describe("S13 scrape(): happy path and failure paths", () => {
	const BASE = "https://festasearraiais.pt/eventos";
	const OK_2026 = `${BASE}/festas-da-vestiaria-2026-vestiaria-1`;
	const OK_2024 = `${BASE}/festas-da-tremoceira-2024-pedreiras-2`;
	const DEAD = `${BASE}/festa-morta-2026-leiria-3`;
	const NO_LD = `${BASE}/festa-sem-ld-2026-leiria-4`;
	const LISBON = `${BASE}/arraial-lisboa-2026-lisboa-5`;
	const lisbonPage = `<script type="application/ld+json">${JSON.stringify({
		"@type": "MusicEvent",
		name: "Arraial de Lisboa",
		startDate: "2026-09-20",
		location: { name: "Alfama", address: { addressLocality: "Lisboa" } },
	})}</script>`;
	const index =
		"<sitemapindex><sitemap><loc>https://festasearraiais.pt/sitemap-eventos.xml</loc></sitemap></sitemapindex>";
	const sitemap = `<urlset>${[OK_2026, OK_2024, DEAD, NO_LD, LISBON]
		.map(
			(u) =>
				`<url><loc>${u}</loc><lastmod>2026-07-17T00:00:00Z</lastmod></url>`,
		)
		.join("")}</urlset>`;
	const pages = new Map([
		[OK_2026, detail2026],
		[OK_2024, detail2024],
		[NO_LD, "<html><body>sem json-ld</body></html>"],
		[LISBON, lisbonPage],
	]);

	function run(seen: string[] = []) {
		const fetched: string[] = [];
		const saved: { seen: string[] }[] = [];
		const promise = scrape(
			{
				fetchText: async (u) => {
					fetched.push(u);
					if (u.endsWith("/sitemap.xml")) {
						return index;
					}
					if (u.endsWith("sitemap-eventos.xml")) {
						return sitemap;
					}
					const html = pages.get(u);
					if (html === undefined) {
						throw new Error(`GET ${u} -> HTTP 500`);
					}
					return html;
				},
				sleep: async () => {},
				loadState: () => ({ seen }),
				saveState: (s) => {
					saved.push(s);
				},
				now: 0,
			},
			isLeiriaDistrict,
		);
		return { promise, fetched, saved };
	}

	test("emits in-district events, gates out Lisboa, counts the dead and the LD-less page", async () => {
		const { promise, saved } = run();
		const res = await promise;
		expect(res.events.map((e) => e.title).sort()).toEqual([
			"Festa em honra de Nossa Sra. D'Ajuda 2026 - Vestiaria",
			"Festas da Tremoceira 2024 - Porto de Mós",
		]);
		expect(res.discovered).toBe(5);
		// the dead page (HTTP 500) and the page without an event block
		expect(res.failures).toBe(2);
		expect(res.firstError).toBeTruthy();
		// index + sitemap + 4 detail pages that answered
		expect(res.pagesFetched).toBe(2 + 4);
		// C7: saved only on commit, and only urls that parsed to an event
		// (emitted or gated out); the one that threw and the page with no
		// event block are not, so both are retried next run
		expect(saved).toHaveLength(0);
		res.commit?.();
		expect([...(saved[0]?.seen ?? [])].sort()).toEqual(
			[OK_2026, OK_2024, LISBON].sort(),
		);
	});

	test("a MusicEvent page is parsed (and then gated by district), not skipped as 'no JSON-LD'", async () => {
		const { promise } = run([OK_2026, OK_2024, DEAD, NO_LD]);
		const res = await promise;
		expect(res.events).toEqual([]);
		expect(res.failures).toBe(0);
	});

	test("seen urls are skipped; only the new ones are fetched", async () => {
		const { promise, fetched } = run([OK_2026, OK_2024, LISBON]);
		await promise;
		expect(fetched.filter((u) => u.includes("/eventos/")).sort()).toEqual(
			[DEAD, NO_LD].sort(),
		);
	});
});
