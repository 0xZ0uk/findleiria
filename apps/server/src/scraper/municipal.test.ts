import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { must } from "../test-helpers";
import { toEpochInLisbon } from "./fingerprint";
import {
	parseDetail,
	parseListingDates,
	parseListingItems,
	parseWallClock,
	SITES,
	scrape,
	slugFor,
	toRawEvent,
} from "./municipal";

const readFixture = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8");

const listing = (key: string) => readFixture(`municipal-${key}-listing.html`);
const detail = (key: string) => readFixture(`municipal-${key}-detail.html`);

/** 2026-09-11 12:00 UTC ≈ "now" for deterministic tests. */
const NOW = Math.floor(Date.UTC(2026, 8, 11, 12, 0, 0) / 1000);

const site = (key: string) => {
	const s = SITES.find((x) => x.key === key);
	if (!s) {
		throw new Error(`no site ${key}`);
	}
	return s;
};

describe("SITES (the wm-smile council family)", () => {
	test("7 concelhos, unique keys/prefixes, paginator only where one exists", () => {
		expect(SITES.length).toBe(7);
		expect(SITES.map((s) => s.key).sort()).toEqual([
			"alvaiazere",
			"ansiao",
			"batalha",
			"marinha-grande",
			"nazare",
			"pedrogao-grande",
			"peniche",
		]);
		expect(new Set(SITES.map((s) => s.prefix)).size).toBe(7);
		for (const s of SITES) {
			expect(s.listing.startsWith(s.origin)).toBe(true);
		}
		// Paginator ids + last page observed live on 2026-09-11.
		expect(SITES.map((s) => [s.key, s.paginator, s.maxPages])).toEqual([
			["marinha-grande", "events_list_13", 44],
			["nazare", "events_list_73", 71],
			["batalha", null, 1],
			["alvaiazere", "events_list_57", 14],
			["ansiao", null, 1],
			["peniche", "events_list_69", 24],
			["pedrogao-grande", null, 1],
		]);
		for (const s of SITES) {
			// A paginator id and a page count must agree: single-page councils
			// carry no paginator, paginated ones never claim maxPages = 1.
			expect(s.paginator == null).toBe(s.maxPages === 1);
		}
	});
});

describe("parseListingItems (real listing fixtures)", () => {
	const expected: Array<[string, number, number]> = [
		// key, server-rendered items, items with no year on the chip
		["marinha-grande", 100, 0],
		["nazare", 12, 0],
		["batalha", 4, 0],
		["alvaiazere", 12, 0],
		["ansiao", 11, 11],
		["peniche", 18, 0],
		["pedrogao-grande", 6, 5],
	];

	for (const [key, count, undated] of expected) {
		test(`${key}: ${count} items (${undated} undated)`, () => {
			const items = parseListingItems(listing(key), site(key));
			expect(items.length).toBe(count);
			expect(new Set(items.map((i) => i.url)).size).toBe(count);
			expect(items.filter((i) => i.latest == null).length).toBe(undated);
			for (const i of items) {
				expect(i.url.startsWith(site(key).origin)).toBe(true);
				expect(i.url).toContain("/evento/");
			}
		});
	}

	test("Marinha Grande's first chip dates the event in Lisbon wall clock", () => {
		const items = parseListingItems(
			listing("marinha-grande"),
			site("marinha-grande"),
		);
		// 26 set. 2026 → 00:00 WEST = 2026-09-25T23:00Z. Never UTC midnight.
		expect(items[0]?.earliest).toBe(toEpochInLisbon(2026, 9, 26));
		expect(items[0]?.latest).toBe(toEpochInLisbon(2026, 9, 26));
		expect(new Date((items[0]?.earliest ?? 0) * 1000).toISOString()).toBe(
			"2026-09-25T23:00:00.000Z",
		);
	});

	test("Nazaré's dated range chip keeps start and end days", () => {
		const items = parseListingItems(listing("nazare"), site("nazare"));
		const bienal = items.find((i) =>
			i.url.includes("bienal-de-fotografia-alvaro-laborinho"),
		);
		expect(bienal?.earliest).toBe(toEpochInLisbon(2026, 10, 17));
		expect(bienal?.latest).toBe(toEpochInLisbon(2026, 11, 22));
		// Crosses the DST fall-back (25 Oct 2026), so the offsets differ.
		expect(new Date((bienal?.earliest ?? 0) * 1000).toISOString()).toBe(
			"2026-10-16T23:00:00.000Z",
		);
		expect(new Date((bienal?.latest ?? 0) * 1000).toISOString()).toBe(
			"2026-11-22T00:00:00.000Z",
		);
	});

	test("an impossible calendar date in a chip degrades to undated, never throws", () => {
		// Live regression (2026-09-11): the Marinha Grande agenda carries a
		// "29.02.23" chip and Feb 2023 has 28 days. toEpochInLisbon threw out of
		// parseListingDates and killed the whole live run of the source.
		expect(parseListingDates("29.02.23")).toEqual({
			earliest: null,
			latest: null,
		});
		expect(
			parseListingDates(
				'class="dia">29<span class="mes_curto">fev<span class="ano">23',
			),
		).toEqual({ earliest: null, latest: null });
		// 29 de fevereiro exists in a leap year...
		expect(parseListingDates("29.02.24").earliest).toBe(
			toEpochInLisbon(2024, 2, 29),
		);
		// ...and a valid date beside a bogus one still survives.
		expect(parseListingDates("29.02.23 2026/10/04").earliest).toBe(
			toEpochInLisbon(2026, 10, 4),
		);
	});

	test("Ansião/Pedrógão Grande chips carry no year at all (undated, need the detail)", () => {
		// Only the no-year chips are undated: Ansião is 11/11, Pedrógão Grande
		// 5/6 (one item carries a full date).
		expect([
			...new Set(
				parseListingItems(listing("ansiao"), site("ansiao")).map((i) =>
					i.latest == null ? "undated" : "dated",
				),
			),
		]).toEqual(["undated"]);
		const pg = parseListingItems(
			listing("pedrogao-grande"),
			site("pedrogao-grande"),
		);
		expect(pg.filter((i) => i.latest == null).length).toBe(5);
		expect(pg.filter((i) => i.latest != null).length).toBe(1);
		// Undated means BOTH ends null — never a fabricated year.
		for (const key of ["ansiao", "pedrogao-grande"]) {
			for (const i of parseListingItems(listing(key), site(key))) {
				if (i.latest == null) {
					expect(i.earliest).toBeNull();
				}
			}
		}
	});
});

describe("parseDetail (real detail fixtures)", () => {
	const expected: Array<{
		key: string;
		title: string;
		atcStart: string | null;
		atcEnd: string | null;
		local: string | null;
		cats: string[];
	}> = [
		{
			key: "marinha-grande",
			title: "FESTA ARRAIAL DO F.C. “OS BELENENSES",
			atcStart: null,
			atcEnd: null,
			local: null,
			cats: [],
		},
		{
			key: "nazare",
			title: "CONCERTO CORAL",
			atcStart: "2026-09-05 21:30:00",
			atcEnd: "2026-09-05 22:30:00",
			local: "Clube Valadense",
			cats: ["Concertos e Espetáculos"],
		},
		{
			key: "batalha",
			title: "Recriação do Mercado do Século XIX",
			atcStart: "2026-09-20 14:00:00",
			atcEnd: "2026-09-20 19:00:00",
			local: "Praça Mouzinho de Albuquerque",
			cats: [],
		},
		{
			key: "alvaiazere",
			title: "Alvaiázere Youth Summer Jobs 2026 | Inscrições Abertas",
			atcStart: "2026-06-01 00:00:00",
			atcEnd: "2026-09-15 00:00:00",
			local: null,
			cats: [],
		},
		{
			key: "ansiao",
			title: "Eu Posso Correr",
			atcStart: "2026-09-07 19:40:00",
			atcEnd: "2026-09-21 19:40:00",
			local:
				"Alvorge, Ansião, Avelar, Chão de Couce, Pousaflores e Santiago da Guarda",
			cats: [],
		},
		{
			key: "peniche",
			title: '10.ª Prova de Águas Abertas "PENICHE A NADAR"',
			atcStart: "2026-08-22 14:30:00",
			atcEnd: "2026-08-22 14:30:00",
			local: "Praia do Molhe de Leste, Peniche",
			cats: ["Desporto"],
		},
		{
			key: "pedrogao-grande",
			title: "Exposição Fotográfica no Jardim da Devesa",
			atcStart: "2026-08-07 18:00:00",
			atcEnd: "2026-08-07 18:00:00",
			local: null,
			cats: [],
		},
	];

	for (const e of expected) {
		test(`${e.key}: title + add-to-calendar date + place`, () => {
			const d = parseDetail(detail(e.key));
			expect(d.title).toBe(e.title);
			expect(d.atcStart).toBe(e.atcStart);
			expect(d.atcEnd).toBe(e.atcEnd);
			expect(d.local).toBe(e.local);
			expect(d.categories).toEqual(e.cats);
			expect(d.imageUrl).toBeTruthy();
			expect((d.description ?? "").length).toBeGreaterThan(0);
		});
	}
});

describe("parseWallClock", () => {
	test("reads the CMS wall-clock string as Lisbon time", () => {
		expect(parseWallClock("2026-09-05 21:30:00")).toBe(
			toEpochInLisbon(2026, 9, 5, 21, 30),
		);
	});

	test("malformed input returns null (never a guessed date)", () => {
		expect(parseWallClock("")).toBeNull();
		expect(parseWallClock(null)).toBeNull();
		expect(parseWallClock("amanhã")).toBeNull();
	});
});

describe("slugFor", () => {
	test("prefixes the concelho onto the detail slug", () => {
		expect(
			slugFor(
				site("marinha-grande"),
				"https://www.cm-mgrande.pt/comunicar/eventos/todos-os-eventos/evento/10-aniversario-do-nucleo-sporting-clube-de-portugal-da-marinha-grande",
			),
		).toBe(
			"mg-10-aniversario-do-nucleo-sporting-clube-de-portugal-da-marinha-grande",
		);
	});
});

describe("toRawEvent", () => {
	test("Marinha Grande: dated, in-district, absolute epochs (no UTC drift)", () => {
		const s = site("marinha-grande");
		const items = parseListingItems(listing("marinha-grande"), s);
		const raw = toRawEvent(
			s,
			must(items[0]).url,
			parseDetail(detail("marinha-grande")),
			NOW,
		);
		expect(raw?.slug).toBe(
			"mg-10-aniversario-do-nucleo-sporting-clube-de-portugal-da-marinha-grande",
		);
		expect(raw?.city).toBe("Marinha Grande");
		expect(raw?.dateText).toBeNull();
		// The MG detail fixture is the Festa Arraial, NOT the listing item at
		// index 0 (that is how fixtures.py captured it), so the mixed pair
		// yields the detail's own start and the chip's day-granular end. Exact
		// day behaviour is pinned by the Batalha/Alvaiázere/Ansião cases above,
		// whose fixtures and listed items agree; here we only pin the shape.
		expect(raw?.startAt).not.toBeNull();
		expect(raw?.endAt).not.toBeNull();
		expect((raw?.endAt ?? 0) > (raw?.startAt ?? 0)).toBe(true);
	});

	test("Batalha: add-to-calendar range becomes start/end", () => {
		const s = site("batalha");
		const raw = toRawEvent(
			s,
			"https://www.cm-batalha.pt/municipe/comunicacao/agenda-cultural/evento/exposicao-pintura-a-oleo-e-azulejaria-contemporanea",
			parseDetail(detail("batalha")),
			NOW,
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 9, 20, 14, 0));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 20, 19, 0));
		expect(raw?.venueName).toBe("Praça Mouzinho de Albuquerque");
		expect(raw?.city).toBe("Batalha");
	});

	test("Ansião: undated chip + timed detail still yields a Lisbon-dated event", () => {
		const s = site("ansiao");
		const items = parseListingItems(listing("ansiao"), s);
		const raw = toRawEvent(
			s,
			must(items[0]).url,
			parseDetail(detail("ansiao")),
			NOW,
		);
		expect(raw?.slug).toBe("an-refletimos-em-conjunto");
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 9, 7, 19, 40));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 21, 19, 40));
		expect(raw?.city).toBe("Ansião");
	});

	test("Alvaiázere: cross-month range keeps both ends", () => {
		const s = site("alvaiazere");
		const raw = toRawEvent(
			s,
			`${s.origin}/municipio/comunicacao/eventos/evento/ix`,
			parseDetail(detail("alvaiazere")),
			NOW,
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 6, 1));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 15));
	});

	test("already-past detail returns null — never rolled forward", () => {
		// The Nazaré detail fixture is a 5 set. concert; the listing item beside
		// it is future. The detail's own date wins, so nothing is invented.
		const raw = toRawEvent(
			site("nazare"),
			"https://www.cm-nazare.pt/visitar/todos-os-eventos/evento/bienal-de-fotografia-alvaro-laborinho",
			parseDetail(detail("nazare")),
			NOW,
		);
		expect(raw).toBeNull();
	});
});

describe("scrape (injected fetchText over the real fixtures)", () => {
	// Every listing page — page 1 AND pages 2..maxPages — returns the SAME
	// fixture HTML, i.e. exactly the roster-repeat a live paginator produces
	// when items shift mid-walk (156 listing pages total: 44+71+1+14+1+24+1).
	// A scraper without the in-run guard emits each item once per page.
	const detailByUrl = new Map<string, string>();
	for (const s of SITES) {
		const html = listing(s.key);
		for (const it of parseListingItems(html, s)) {
			detailByUrl.set(it.url, detail(s.key));
		}
	}

	const fetchFor = (broken: string | null) => async (u: string) => {
		if (broken && u.startsWith(broken)) {
			throw new Error("network down");
		}
		const d = detailByUrl.get(u);
		if (d) {
			return d;
		}
		for (const s of SITES) {
			if (u === s.listing || u.startsWith(`${s.listing}?`)) {
				return listing(s.key);
			}
		}
		throw new Error(`no fixture for ${u}`);
	};

	const deps = (seen: string[], broken: string | null = null) => ({
		fetchText: fetchFor(broken),
		sleep: async () => {},
		loadState: () => ({ seen }),
		saveState: () => {},
		now: NOW,
	});

	const allUrls = [...detailByUrl.keys()];

	test("first run: 163 items discovered, zero duplicate slugs emitted", async () => {
		const res = await scrape(deps([]), () => true);
		expect(res.failures).toBe(0);
		expect(res.firstError).toBeNull();
		expect(res.discovered).toBe(163);
		// 156 listing pages + 55 detail pages.
		expect(res.pagesFetched).toBe(211);
		const slugs = res.events.map((e) => e.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(slugs.length).toBe(40);
		// Everything that survives is district-local and prefixed per council.
		expect(
			res.events.every((e) =>
				SITES.some((s) => e.slug.startsWith(`${s.prefix}-`)),
			),
		).toBe(true);
		expect([...new Set(res.events.map((e) => e.city))].sort()).toEqual([
			"Alvaiázere",
			"Ansião",
			"Batalha",
			"Marinha Grande",
		]);
	});

	test("steady state: everything already seen emits nothing new", async () => {
		const res = await scrape(deps(allUrls), () => true);
		expect(res.events.length).toBe(0);
		// Still discovered — the walk is what tells us the roster is unchanged.
		expect(res.discovered).toBe(163);
		expect(res.failures).toBe(0);
	});

	test("a council that dies does not stop the others and yields no half-events", async () => {
		const res = await scrape(
			deps([], "https://www.cm-mgrande.pt/comunicar/eventos"),
			() => true,
		);
		// Two consecutive fully-failed pages end the council (6 requests, not
		// all 44); each dead page is one failure in the run record.
		expect(res.failures).toBe(2);
		expect(res.firstError).toContain("network down");
		expect(res.events.length).toBeGreaterThan(0);
		expect(res.events.some((e) => e.city === "Marinha Grande")).toBe(false);
	});

	test("a page that 403s mid-walk is skipped (one attempt), and the tail still walks", async () => {
		// Live regression: the Marinha Grande paginator answered 403 at page 31
		// of 44, and the old `break` meant pages 32-44 were never fetched on
		// ANY run — their items could never be discovered.
		let deadPageAttempts = 0;
		const base = fetchFor(null);
		const res = await scrape(
			{
				...deps([]),
				fetchText: async (u: string) => {
					if (u.includes("events_list_13_page=31")) {
						deadPageAttempts++;
						throw new Error("HTTP 403");
					}
					return base(u);
				},
			},
			() => true,
		);
		// http.ts owns retries: the scraper makes exactly ONE attempt per page.
		expect(deadPageAttempts).toBe(1);
		// 156 listing pages − the dead one + 55 detail pages.
		expect(res.pagesFetched).toBe(210);
		expect(res.discovered).toBe(163);
		expect(res.events.length).toBe(40);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("page=31");
	});

	test("S7: a council whose first page parses to zero items is a counted failure", async () => {
		const base = fetchFor(null);
		const batalha = must(SITES.find((s) => s.key === "batalha"));
		const res = await scrape(
			{
				...deps([]),
				fetchText: async (u: string) =>
					u === batalha.listing
						? "<html><body>Just a moment...</body></html>"
						: base(u),
			},
			() => true,
		);
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain("zero items");
		expect(res.firstError).toContain(batalha.listing);
		// The other councils still ran.
		expect(res.events.length).toBeGreaterThan(0);
	});

	test("out-of-district city is dropped by the injected gate", async () => {
		const res = await scrape(deps([]), (city) => city === "Batalha");
		expect(res.events.length).toBeGreaterThan(0);
		expect(res.events.every((e) => e.city === "Batalha")).toBe(true);
	});

	test("C7: seen is saved only on commit; an unparsable detail stays unseen, gated-out ones are seen", async () => {
		const base = fetchFor(null);
		const first = await scrape(deps([]), () => true);
		const victim = first.events[0]?.url ?? "";
		const saved: { seen: string[] }[] = [];
		const res = await scrape(
			{
				...deps([]),
				saveState: (s: { seen: string[] }) => {
					saved.push(s);
				},
				fetchText: async (u: string) =>
					u === victim ? "<html><body></body></html>" : base(u),
			},
			(city) => city === "Batalha",
		);
		expect(saved).toHaveLength(0);
		res.commit();
		const seen = new Set(saved[0]?.seen ?? []);
		expect(victim).not.toBe("");
		expect(seen.has(victim)).toBe(false);
		// Emitted and gated-out (other councils) items alike are done with.
		for (const e of first.events) {
			if (e.url !== victim) expect(seen.has(e.url)).toBe(true);
		}
	});

	describe("S12: listing page counts come from the markup", () => {
		const nazare = site("nazare");
		const nazareListingRequests = (log: string[]) =>
			log.filter((u) => u.startsWith(`${nazare.listing}?`)).length + 1;
		const run = async (rewrite: (html: string) => string) => {
			const log: string[] = [];
			const base = fetchFor(null);
			const res = await scrape(
				{
					...deps(allUrls),
					fetchText: async (u: string) => {
						log.push(u);
						const html = await base(u);
						return u.startsWith(nazare.listing) ? rewrite(html) : html;
					},
				},
				() => true,
			);
			return { res, log };
		};

		test("the last page is read from page 1's paginator links", async () => {
			// Nazaré advertises 71; pretend the council shrank to 5 pages.
			const { log } = await run((html) =>
				html.replace(/events_list_73_page=(\d+)/g, (m, n) =>
					Number(n) > 5 ? "events_list_73_page=5" : m,
				),
			);
			expect(nazareListingRequests(log)).toBe(5);
		});

		test("the hardcoded maxPages is an upper safety cap", async () => {
			const { log } = await run((html) =>
				html.replace(/events_list_73_page=71/g, "events_list_73_page=999"),
			);
			expect(nazareListingRequests(log)).toBe(nazare.maxPages);
		});

		test("an unreadable paginator falls back to the cap", async () => {
			const { log } = await run((html) =>
				html.replace(/events_list_73_page=/g, "events_list_73_p="),
			);
			expect(nazareListingRequests(log)).toBe(nazare.maxPages);
		});

		test("a council without a paginator fetches its single page", async () => {
			const batalha = site("batalha");
			const { log } = await run((html) => html);
			expect(log.filter((u) => u.startsWith(batalha.listing))).toEqual([
				batalha.listing,
			]);
		});
	});

	describe("pages that never parse stop being refetched", () => {
		/** A persistent state file across simulated runs, like state/municipal.json. */
		const simulate = (victim: string) => {
			let state: { seen: string[]; attempts?: Record<string, number> } = {
				seen: [],
			};
			const base = fetchFor(null);
			const fetched: string[] = [];
			const runOnce = async () => {
				fetched.length = 0;
				const res = await scrape(
					{
						...deps([]),
						loadState: () => state,
						saveState: (s) => {
							state = s;
						},
						fetchText: async (u: string) => {
							fetched.push(u);
							return u === victim ? "<html><body></body></html>" : base(u);
						},
					},
					(city) => city === "Batalha",
				);
				res.commit();
				return res;
			};
			return { runOnce, fetched, getState: () => state };
		};

		test("3 failed parses mark the url seen, report it once, and stop refetching", async () => {
			const victim = (await scrape(deps([]), () => true)).events[0]?.url ?? "";
			expect(victim).not.toBe("");
			const sim = simulate(victim);

			for (const attempt of [1, 2]) {
				const res = await sim.runOnce();
				expect(sim.fetched).toContain(victim);
				expect(sim.getState().attempts?.[victim]).toBe(attempt);
				expect(sim.getState().seen).not.toContain(victim);
				expect(res.failures).toBe(0);
			}

			const third = await sim.runOnce();
			expect(sim.fetched).toContain(victim);
			expect(third.failures).toBe(1);
			expect(third.firstError).toContain(victim);
			expect(third.firstError).toContain("unparseable after 3 attempts");
			expect(sim.getState().seen).toContain(victim);
			expect(sim.getState().attempts?.[victim]).toBeUndefined();

			const fourth = await sim.runOnce();
			expect(sim.fetched).not.toContain(victim);
			expect(fourth.failures).toBe(0);
		});

		test("attempts are saved only on commit (C7)", async () => {
			const victim = (await scrape(deps([]), () => true)).events[0]?.url ?? "";
			let saved = 0;
			const base = fetchFor(null);
			const res = await scrape(
				{
					...deps([]),
					saveState: () => {
						saved++;
					},
					fetchText: async (u: string) =>
						u === victim ? "<html><body></body></html>" : base(u),
				},
				() => true,
			);
			expect(saved).toBe(0);
			res.commit();
			expect(saved).toBe(1);
		});

		test("a state file from before attempts existed loads and counts from zero", async () => {
			const victim = (await scrape(deps([]), () => true)).events[0]?.url ?? "";
			const sim = simulate(victim);
			await sim.runOnce();
			expect(sim.getState().attempts?.[victim]).toBe(1);
		});
	});
});
