import { describe, expect, test } from "bun:test";

import { UNKNOWN_CITY } from "./venue-city";
import { type MergeVenue, planVenueMerge } from "./venues";

/** Deterministic PRNG (mulberry32) so the venue set is the same every run. */
function prng(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Name families with the spellings sources actually use. */
const FAMILIES: string[][] = [
	[
		"BLACK BOX",
		"Black Box - Plataforma de Criação Artística de Leiria",
		"Black Box",
	],
	[
		"Teatro José Lúcio da Silva",
		"Teatro Jose Lucio da Silva",
		"Teatro José Lúcio",
	],
	["Mercado de Leiria", "Mercado Municipal de Leiria", "Mercado Municipal"],
	["Biblioteca Municipal", "Biblioteca Municipal Afonso Lopes Vieira"],
	["Cine-Teatro", "Cineteatro Municipal", "Cine Teatro"],
	["Castelo de Leiria", "Castelo"],
	["Igreja Matriz", "Igreja Matriz de São Pedro"],
	["Casa da Cultura", "Casa da Cultura de Pombal"],
	["Stereogun", "Stereogun Bar"],
	["Praça Rodrigues Lobo", "Praca Rodrigues Lobo"],
	["Mosteiro da Batalha", "Mosteiro de Santa Maria da Vitória"],
	["Jardim Luís de Camões", "Jardim Luis de Camoes"],
];
/** Vague rows: never a merge hub. */
const VAGUE = [
	"Leiria (cidade)",
	"Concelho de Leiria",
	"Vários Espaços Culturais",
];
/** Towns, including parish/concelho spellings of one key and unknown towns. */
const TOWNS = [
	"Leiria",
	"Batalha",
	"Pombal",
	"Marinha Grande",
	"Ordem",
	"Caldas da Rainha",
	"Alcobaça",
	"Nazaré",
	"Leiria e arredores",
	UNKNOWN_CITY,
	"",
];

function venueSet(n: number, seed: number): MergeVenue[] {
	const rand = prng(seed);
	const pick = <T>(xs: readonly T[]): T =>
		xs[Math.floor(rand() * xs.length)] as T;
	const out: MergeVenue[] = [];
	for (let id = 1; id <= n; id++) {
		const r = rand();
		const name =
			r < 0.08
				? pick(VAGUE)
				: r < 0.7
					? pick(pick(FAMILIES))
					: // Long-tail one-off venues, sometimes sharing a token.
						`${pick(["Sala", "Bar", "Café", "Auditório", "Espaço"])} ${pick(["Aurora", "Lis", "Pinhal", "Atlântico", "Fonte"])} ${Math.floor(rand() * 40)}`;
		const located = rand() < 0.3;
		out.push({
			id,
			name,
			city: pick(TOWNS),
			slug: `v-${id}`,
			address: rand() < 0.2 ? `Rua ${id}` : null,
			lat: located ? 39.7 + rand() / 10 : null,
			lng: located ? -8.8 + rand() / 10 : null,
		});
	}
	return out;
}

describe("venue merge blocking (C8)", () => {
	test("the blocked plan is identical to the all-pairs plan on varied venue sets", () => {
		const steps = [];
		for (const [n, seed] of [
			[60, 1],
			[250, 7],
			[600, 42],
		] as const) {
			const venues = venueSet(n, seed);
			const rand = prng(seed + 1);
			const counts = new Map(
				venues.map((v) => [v.id, Math.floor(rand() * 5)] as const),
			);
			let t = performance.now();
			const reference = planVenueMerge(venues, counts, "all-pairs");
			const allPairsMs = performance.now() - t;
			t = performance.now();
			const blocked = planVenueMerge(venues, counts, "blocked");
			const blockedMs = performance.now() - t;
			console.log(
				`venue merge plan @${n} venues: all-pairs ${allPairsMs.toFixed(0)}ms, blocked ${blockedMs.toFixed(0)}ms`,
			);
			expect(blocked).toEqual(reference);
			expect(reference.length).toBeGreaterThan(3);
			steps.push(...reference);
		}
		// Non-trivial sets: inherited geocodes, addresses and town folds occur.
		expect(steps.some((s) => s.fill.lat != null)).toBe(true);
		expect(steps.some((s) => s.fill.address != null)).toBe(true);
		expect(steps.some((s) => s.fill.city != null)).toBe(true);
	});
});
