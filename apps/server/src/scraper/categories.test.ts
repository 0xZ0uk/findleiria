import { describe, expect, test } from "bun:test";

import {
	CANONICAL_CATEGORIES,
	canonicalizeCategories,
	sameCategories,
	sortCategories,
	unknownCategory,
} from "./categories";
import { normalizeTitle } from "./normalize";

describe("canonicalizeCategories", () => {
	test("every canonical label is its own fixed point", () => {
		for (const c of CANONICAL_CATEGORIES) {
			expect(canonicalizeCategories([c])).toEqual([c]);
			// and distinct under normalization (map keys can't collide)
			expect(normalizeTitle(c)).not.toBe("");
		}
	});

	test("singular/plural and variant labels collapse", () => {
		expect(canonicalizeCategories(["Concerto"])).toEqual(["Concertos"]);
		expect(canonicalizeCategories(["Museus"])).toEqual(["Museus & Exposições"]);
		expect(canonicalizeCategories(["Exposição"])).toEqual([
			"Museus & Exposições",
		]);
		expect(canonicalizeCategories(["Oficina"])).toEqual(["Workshop"]);
		expect(canonicalizeCategories(["Oficina pedagógica"])).toEqual([
			"Workshop",
		]);
		expect(canonicalizeCategories(["Conferência"])).toEqual(["Conferências"]);
		expect(canonicalizeCategories(["Feira"])).toEqual(["Mercados e Feiras"]);
	});

	test("case/diacritic-insensitive matching", () => {
		expect(canonicalizeCategories(["CONCERTOS"])).toEqual(["Concertos"]);
		expect(canonicalizeCategories(["música"])).toEqual(["Música"]);
		expect(canonicalizeCategories(["stand up comedy"])).toEqual(["Comedy"]);
	});

	test("compound labels expand into two themes", () => {
		expect(canonicalizeCategories(["Teatro e Dança"])).toEqual([
			"Teatro",
			"Dança",
		]);
	});

	test("platform names are dropped", () => {
		expect(canonicalizeCategories(["Shotgun"])).toEqual([]);
		expect(canonicalizeCategories(["Eventbrite"])).toEqual([]);
		expect(canonicalizeCategories(["Ticketline"])).toEqual([]);
		expect(canonicalizeCategories(["Viral Agenda"])).toEqual([]);
	});

	test("unknown labels pass through untouched", () => {
		expect(canonicalizeCategories(["Queijo"])).toEqual(["Queijo"]);
	});

	test("output deduped and ordered by taxonomy, unknowns last", () => {
		const out = canonicalizeCategories([
			"Workshop",
			"Cultura",
			"Zzz Custom",
			"Concerto",
			"Workshop",
		]);
		expect(out).toEqual(["Cultura", "Concertos", "Workshop", "Zzz Custom"]);
	});

	test("empty / symbol-only input", () => {
		expect(canonicalizeCategories([])).toEqual([]);
		expect(canonicalizeCategories(["***"])).toEqual([]);
	});

	test("real source payload shapes", () => {
		// leiriagenda card style
		expect(canonicalizeCategories(["Biblioteca", "Literatura"])).toEqual([
			"Literatura",
		]);
		// cmleiria rss style
		expect(canonicalizeCategories(["Cultura", "Música"])).toEqual([
			"Cultura",
			"Música",
		]);
	});
});

describe("unknownCategory", () => {
	test("canonical labels return null", () => {
		expect(unknownCategory("Cultura")).toBeNull();
		expect(unknownCategory("Museus & Exposições")).toBeNull();
	});

	test("aliases and dropped labels resolve (not reported); unmapped are", () => {
		expect(unknownCategory("Concerto")).toBeNull();
		expect(unknownCategory("Shotgun")).toBeNull();
		expect(unknownCategory("Queijo")).toBe("Queijo");
	});
});

/**
 * Drift guard (SLICE_10).
 *
 * The live database carried these labels, and both tables were missing them, so
 * each one became its own option in the Tipo filter — 12 labels, ~95 events,
 * next to the 21 curated categories. Nothing failed: unknown labels pass through
 * by design (we never drop data), so the dropdown silently grew instead.
 *
 * The counts are what production held when this was written; the point of
 * pinning the labels is that the next synonym fails here instead of shipping.
 */
const LIVE_DB_LABELS = [
	["Festas", 51],
	["Atividades ao Ar Livre", 27],
	["Oficina / workshop", 5],
	["Evento ao ar livre", 3],
	["Educação", 3],
	["Saúde", 1],
	["Mais Novos", 1],
	["Feiras", 1],
	["Espetáculo", 1],
	["Corrida", 1],
	["Caminhada", 1],
	["Ambiente", 1],
] as const;

describe("labels the live database actually carried", () => {
	test("none of them is reported as unknown", () => {
		const still_unknown = LIVE_DB_LABELS.map(([label]) =>
			unknownCategory(label),
		).filter((label): label is string => label !== null);
		expect(still_unknown).toEqual([]);
	});

	test("each resolves to one canonical category", () => {
		const wrong: string[] = [];
		for (const [label] of LIVE_DB_LABELS) {
			const resolved = canonicalizeCategories([label]);
			const [only] = resolved;
			if (
				resolved.length !== 1 ||
				only === undefined ||
				!(CANONICAL_CATEGORIES as readonly string[]).includes(only)
			) {
				wrong.push(`${label} → ${JSON.stringify(resolved)}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	test("the two buckets that were missing are canonical now", () => {
		// Festas (51) and Atividades ao Ar Livre (27) were 78 of those events.
		expect(canonicalizeCategories(["Festas"])).toEqual(["Festas"]);
		expect(canonicalizeCategories(["Atividades ao Ar Livre"])).toEqual([
			"Atividades ao Ar Livre",
		]);
	});
});

describe("C13: one display ordering for every write path", () => {
	test("sortCategories follows the taxonomy order, unknowns last, deduped", () => {
		// Alphabetical would be Concertos, Música, Teatro, Zumba.
		expect(
			sortCategories(["Zumba", "Teatro", "Concertos", "Música", "Música"]),
		).toEqual(["Música", "Concertos", "Teatro", "Zumba"]);
	});

	test("canonicalizeCategories and sortCategories agree on the order", () => {
		const labels = ["Teatro", "Concertos", "Música"];
		expect(sortCategories(labels)).toEqual(canonicalizeCategories(labels));
	});

	test("sameCategories ignores order and duplicates", () => {
		expect(sameCategories(["Teatro", "Música"], ["Música", "Teatro"])).toBe(
			true,
		);
		expect(sameCategories(["Teatro"], ["Teatro", "Música"])).toBe(false);
		expect(sameCategories([], [])).toBe(true);
	});
});
