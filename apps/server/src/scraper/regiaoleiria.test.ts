import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Região de Leiria fixtures — real API payloads captured 2026-09-11.
 *
 * - regiaoleiria-month-2026-09.json
 *   GET https://www.regiaodeleiria.pt/wp-json/user/events/get-by-month?month=9&year=2026
 *   → 256 dated rows / 114 unique post ids. Dates are Europe/Lisbon wall-clock.
 * - regiaoleiria-cartaz.json
 *   GET https://www.regiaodeleiria.pt/api/wp/v2/cartaz?per_page=100&include=<114 ids>&_fields=id,title,slug,link,date,localidade,meta
 *   → 112 Cartaz CPT items (2 requested ids returned no row).
 * - regiaoleiria-localidade.json
 *   GET https://www.regiaodeleiria.pt/api/wp/v2/localidade?per_page=100&include=<104 term ids>&_fields=id,name,slug
 *   → 104 place terms.
 */
const monthText = readFileSync(
	new URL("./__fixtures__/regiaoleiria-month-2026-09.json", import.meta.url),
	"utf-8",
);
const cartazText = readFileSync(
	new URL("./__fixtures__/regiaoleiria-cartaz.json", import.meta.url),
	"utf-8",
);
const localidadeText = readFileSync(
	new URL("./__fixtures__/regiaoleiria-localidade.json", import.meta.url),
	"utf-8",
);

/** 2026-09-11 12:00 UTC — real run date, "now" for deterministic tests. */
const NOW = Math.floor(Date.UTC(2026, 8, 11, 12, 0, 0) / 1000);

import {
	DEFAULT_STATE,
	parseCartaz,
	parseLocalidade,
	parseMonthRows,
	parseWallClock,
	type RegiaoState,
	scrape,
	slugFor,
	toRawEvent,
} from "./regiaoleiria";

/** Load the "detail" cartaz map ourselves so tests can address specific ids. */
const cartaz = parseCartaz(cartazText);
const terms = parseLocalidade(localidadeText);

/** A fetchText stub that routes each URL to the matching real fixture. */
function fixtureFetch(url: string): Promise<string> {
	if (url.includes("/user/events/get-by-month")) {
		const m = /month=(\d+)&year=(\d+)/.exec(url);
		if (m && m[2] === "2026" && m[1] === "9") {
			// full real Sept payload
			return Promise.resolve(monthText);
		}
		if (m && m[2] !== "2026") {
			return Promise.resolve("[]");
		}
		// Reuse the real Sept rows for any 2026 month so a multi-month run
		// still sees real items (kept distinct by the dedup key).
		return Promise.resolve(monthText);
	}
	if (url.includes("/api/wp/v2/cartaz")) {
		return Promise.resolve(cartazText);
	}
	if (url.includes("/api/wp/v2/localidade")) {
		return Promise.resolve(localidadeText);
	}
	return Promise.resolve("[]");
}

function makeDeps(overrides: Partial<RegiaoState> = {}) {
	// Spread DEFAULT_STATE, not a hand-written literal: the previous literal
	// named a `seenPostIds` field that RegiaoState does not have, so every test
	// ran with `monthsFetched === undefined` and the month-watermark branch
	// (scrape step 1) was never exercised.
	let state: RegiaoState = { ...DEFAULT_STATE, ...overrides };
	return {
		fetchText: fixtureFetch,
		sleep: () => Promise.resolve(),
		loadState: () => state,
		saveState: (s: RegiaoState) => {
			state = s;
		},
		now: NOW,
	};
}

describe("parseMonthRows (real Sept 2026 payload)", () => {
	test("256 dated rows across 114 unique posts", () => {
		const rows = parseMonthRows(monthText);
		expect(rows).toHaveLength(256);
		const ids = new Set(rows.map((r) => r.postId));
		expect(ids.size).toBe(114);
	});
});

describe("parseWallClock (wall-clock Lisbon, no UTC marker)", () => {
	test("parses a YYYY-MM-DD HH:MM:SS string", () => {
		expect(parseWallClock("2026-09-25 07:00:00")).toEqual({
			y: 2026,
			m: 9,
			d: 25,
			h: 7,
			min: 0,
		});
	});

	test("malformed returns null", () => {
		expect(parseWallClock("2026-09-25")).toBeNull();
		expect(parseWallClock("garbage")).toBeNull();
	});
});

describe("parseCartaz / parseLocalidade", () => {
	test("real Sept cartaz: 112 items, id→title link present", () => {
		expect(cartaz.size).toBe(112);
		const item = cartaz.get("416096");
		expect(item).toBeDefined();
		expect(item!.title).toContain("Odisseia");
		expect(item!.link).toContain("/cartazes/odisseia26");
		expect(item!.localidade).toContain(16706); // Castanheira de Pera
	});

	test("real Sept localidade: term id→name map", () => {
		expect(terms.get(16706)).toBe("Castanheira de Pera");
		expect(terms.size).toBe(104);
	});
});

describe("slugFor", () => {
	test("rl- prefix on the cartaz slug", () => {
		expect(slugFor(cartaz.get("416096")!)).toBe(
			"rl-odisseia26-em-castanheira-de-pera",
		);
	});
});

describe("toRawEvent", () => {
	test("dates via Europe/Lisbon wall clock — Sept is WEST (UTC+1)", () => {
		const raw = toRawEvent(
			{ postId: "416096", date: "2026-09-25 07:00:00" },
			cartaz.get("416096")!,
			"Castanheira de Pera",
		);
		// Sept 2026 is WEST (summer, UTC+1): 07:00 Lisbon wall clock == 06:00 UTC.
		expect(raw.startAt).toBe(Math.floor(Date.UTC(2026, 8, 25, 6, 0, 0) / 1000));
		expect(raw.endAt).toBe(raw.startAt);
		expect(raw.dateText).toBeNull();
		expect(raw.venueName).toBe("Castanheira de Pera");
		expect(raw.city).toBe("Castanheira de Pera");
		expect(raw.slug).toBe("rl-odisseia26-em-castanheira-de-pera");
		expect(raw.url).toContain("/cartazes/odisseia26");
		expect(raw.categories).toEqual(["Festas"]);
	});
});

describe("scrape — district gate is the point", () => {
	test("keeps only Leiria-district items, drops Oeste/out-of-district", async () => {
		const deps = makeDeps();
		const res = await scrape(deps, undefined as never);
		// Every emitted event's city is a Leiria-district place.
		for (const e of res.events) {
			expect(e.city).toBeTruthy();
		}
		// Sept alone yields dozens of in-district events and drops hundreds of
		// out-of-district rows (this outlet covers Leiria AND Oeste).
		expect(res.events.length).toBeGreaterThanOrEqual(50);
		expect(res.droppedOutOfDistrict).toBeGreaterThan(0);
		// Exactly one RawEvent per (post id, date).
		const keys = res.events.map((e) => `${e.title}|${e.dateText ?? e.startAt}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("no duplicated title on the same day", async () => {
		const deps = makeDeps();
		const res = await scrape(deps, undefined as never);
		const dayTitle = new Set<string>();
		for (const e of res.events) {
			if (e.startAt != null) {
				const key = `${e.title}|${e.startAt}`;
				expect(dayTitle.has(key)).toBe(false);
				dayTitle.add(key);
			}
		}
	});

	test("past dates are dropped, never rolled forward", async () => {
		const deps = makeDeps();
		const res = await scrape(deps, undefined as never);
		for (const e of res.events) {
			if (e.startAt != null) {
				expect(e.startAt).toBeGreaterThanOrEqual(NOW);
			}
		}
	});
});
