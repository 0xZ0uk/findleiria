import { describe, expect, test } from "bun:test";
import {
	dayIdentityKey,
	identityKey,
	planComponents,
	planMerge,
	sourceTrust,
	TIME_SOURCE_PRIORITY,
	venueCompatible,
} from "./identity";
import { sources } from "./index";

describe("sourceTrust", () => {
	test("municipal agenda outranks platforms; viralagenda is last", () => {
		expect(sourceTrust("leiriagenda")).toBeLessThan(sourceTrust("eventbrite"));
		expect(sourceTrust("eventbrite")).toBeLessThan(sourceTrust("ticketline"));
		expect(sourceTrust("ticketline")).toBeLessThan(sourceTrust("viralagenda"));
	});

	test("manual (paste-a-link) ingest outranks every scraper", () => {
		expect(sourceTrust("manual")).toBe(0);
		expect(sourceTrust("manual")).toBeLessThan(sourceTrust("leiriagenda"));
	});

	test("viralagenda is last among known sources", () => {
		for (const id of TIME_SOURCE_PRIORITY) {
			if (id === "viralagenda") continue;
			expect(sourceTrust(id)).toBeLessThan(sourceTrust("viralagenda"));
		}
	});

	test("a truly unknown source still ranks below every known source", () => {
		expect(sourceTrust("some-new-source")).toBe(TIME_SOURCE_PRIORITY.length);
		expect(sourceTrust("some-new-source")).toBeGreaterThan(
			sourceTrust("viralagenda"),
		);
	});

	test("every registered scraper source is ranked for time trust", () => {
		const ranked: readonly string[] = TIME_SOURCE_PRIORITY;
		const missing = Object.keys(sources).filter((id) => !ranked.includes(id));
		expect(missing).toEqual([]);
	});
});

describe("identityKey", () => {
	test("diacritics/case/punctuation collapse to one key", () => {
		const a = identityKey("Ágora — Música no Castelo", "Castelo de Leiria", 0);
		const b = identityKey("agora musica no castelo", "castelo-de-leiria", 0);
		expect(a).toBe(b);
	});

	test("different Lisbon days are different identities", () => {
		// 2026-09-11 23:30 WEST vs 2026-09-12 00:00 WEST.
		const a = identityKey("X", "venue", 1789165800);
		const b = identityKey("X", "venue", 1789167600);
		expect(a).not.toBe(b);
	});
});

describe("planMerge (same-day sessions vs cross-source dupes)", () => {
	test("DST-shifted viralagenda twin is absorbed into the municipal row", () => {
		const la = {
			id: 19,
			title: "X",
			start_at: 1789158600,
			sources: ["leiriagenda"],
		};
		const va = {
			id: 226,
			title: "X",
			start_at: 1789155000,
			sources: ["viralagenda"],
		};
		const plan = planMerge([la, va]);
		expect(plan.keepers.map((k) => k.id)).toEqual([19]);
		expect(plan.absorbed.get(226)).toBe(19);
	});

	test("two municipal sessions at different times are BOTH kept", () => {
		// A Bebé curiosa: 10:00 + 11:30, both leiriagenda — legitimate sessions.
		const s1 = {
			id: 9,
			title: "X",
			start_at: 1789010400,
			sources: ["leiriagenda"],
		};
		const s2 = {
			id: 13,
			title: "X",
			start_at: 1789015800,
			sources: ["leiriagenda"],
		};
		const va = {
			id: 225,
			title: "X",
			start_at: 1789006800,
			sources: ["viralagenda"],
		};
		const plan = planMerge([s1, s2, va]);
		expect(plan.keepers.map((k) => k.id).sort((a, b) => a - b)).toEqual([
			9, 13,
		]);
		// The VA row is absorbed into its NEAREST session in time (10:00).
		expect(plan.absorbed.get(225)).toBe(9);
	});

	test("each absorbed row goes to its nearest keeper session", () => {
		const s1 = { id: 1, title: "X", start_at: 1000, sources: ["leiriagenda"] };
		const s2 = { id: 2, title: "X", start_at: 9000, sources: ["leiriagenda"] };
		const early = {
			id: 3,
			title: "X",
			start_at: 1200,
			sources: ["viralagenda"],
		};
		const late = {
			id: 4,
			title: "X",
			start_at: 8800,
			sources: ["viralagenda"],
		};
		const plan = planMerge([s1, s2, early, late]);
		expect(plan.absorbed.get(3)).toBe(1);
		expect(plan.absorbed.get(4)).toBe(2);
	});

	test("unattributed rows are always absorbed (orphans)", () => {
		const orphan = { id: 3, title: "X", start_at: 100, sources: [] };
		const known = { id: 4, title: "X", start_at: 9999, sources: ["shotgun"] };
		const plan = planMerge([orphan, known]);
		expect(plan.keepers.map((k) => k.id)).toEqual([4]);
		expect(plan.absorbed.get(3)).toBe(4);
	});
});

describe("SESSION_WINDOW cluster boundary (RULE 3)", () => {
	test("3600s apart in the highest-trust tier is ONE keeper (incl.)", () => {
		const early = {
			id: 50,
			title: "X",
			start_at: 1789158600,
			sources: ["leiriagenda"],
		};
		const shifted = {
			id: 51,
			title: "X",
			start_at: 1789158600 + 3600,
			sources: ["leiriagenda"],
		};
		const plan = planMerge([early, shifted]);
		expect(plan.keepers.map((k) => k.id)).toEqual([50]);
	});

	test("5400s apart in the highest-trust tier is TWO keepers", () => {
		const s1 = { id: 50, title: "X", start_at: 1000, sources: ["leiriagenda"] };
		const s2 = {
			id: 51,
			title: "X",
			start_at: 1000 + 5400,
			sources: ["leiriagenda"],
		};
		const plan = planMerge([s1, s2]);
		expect(plan.keepers.map((k) => k.id).sort((a, b) => a - b)).toEqual([
			50, 51,
		]);
	});

	test("the cross-source keeper keeps its own earliest time; the twins absorbed", () => {
		// Concerto ESQUERDA — BLACK BOX named two ways, the municipal row is
		// authoritative at 21:30 (1789245000), the rest fold into it.
		const la = {
			id: 11,
			title: "Concerto ESQUERDA",
			start_at: 1789245000,
			sources: ["leiriagenda"],
		};
		const va = {
			id: 12,
			title: "Concerto ESQUERDA",
			start_at: 1789241400,
			sources: ["viralagenda"],
		};
		const eb = {
			id: 13,
			title: "Concerto ESQUERDA",
			start_at: 1789245000,
			sources: ["eventbrite"],
		};
		const plan = planMerge([la, va, eb]);
		expect(plan.keepers).toHaveLength(1);
		expect(plan.keepers[0]?.id).toBe(11);
		expect(plan.keepers[0]?.start_at).toBe(1789245000);
		expect(plan.absorbed.get(12)).toBe(11);
		expect(plan.absorbed.get(13)).toBe(11);
	});
});

describe("venueCompatible (RULE 2 wildcard for event identity)", () => {
	test("two vague venues match regardless of name", () => {
		expect(
			venueCompatible(
				"Leiria (cidade)",
				"Vários Espaços Culturais",
				"Leiria",
				"Leiria",
			),
		).toBe(true);
	});
	test("a vague venue matches a specific venue in the same city", () => {
		expect(
			venueCompatible(
				"Leiria (cidade)",
				"Mercado de Leiria",
				"Leiria",
				"Leiria",
			),
		).toBe(true);
	});
	test("a vague venue does NOT match a venue in a different city", () => {
		expect(
			venueCompatible(
				"Leiria (cidade)",
				"Mercado de Leiria",
				"Leiria",
				"Lisboa",
			),
		).toBe(false);
	});
	test("two specific venues only match under strict venuesMatch", () => {
		expect(
			venueCompatible(
				"Teatro José Lúcio da Silva",
				"Teatro José Lúcio Da Silva (Leiria)",
				"Leiria",
				"Leiria",
			),
		).toBe(true);
		expect(
			venueCompatible(
				"Mercado de Leiria",
				"Teatro José Lúcio da Silva",
				"Leiria",
				"Leiria",
			),
		).toBe(false);
	});
});

describe("venueCompatible city scope (RULE 2 regression)", () => {
	// The placeholder row's own city is itself a scope string ("Leiria e
	// arredores"), so it must compare equal to "Leiria" or this cross-source
	// duplicate survives with no other disagreement.
	test("a vague venue whose city carries a scope filler matches the bare city", () => {
		expect(
			venueCompatible(
				"Leiria (cidade)",
				"Centro Histórico de Leiria",
				"Leiria e arredores",
				"Leiria",
			),
		).toBe(true);
	});
	test("a scope-filler city still never crosses municipalities", () => {
		expect(
			venueCompatible(
				"Leiria (cidade)",
				"Mercado Municipal",
				"Leiria e arredores",
				"Lisboa",
			),
		).toBe(false);
	});
});

describe("planComponents (cross-source event grouping)", () => {
	test("ESQUERDA pair with split venue naming collapses into one component", () => {
		const comps = planComponents([
			{
				id: 1,
				title: "Concerto ESQUERDA",
				start_at: 1789245000,
				venue: "BLACK BOX",
				city: "Leiria",
			},
			{
				id: 2,
				title: "Concerto ESQUERDA",
				start_at: 1789245000,
				venue: "Black Box - Plataforma de Criação Artística de Leiria",
				city: "Leiria",
			},
		]);
		expect(comps).toHaveLength(1);
		expect(comps[0]?.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
	});

	test("same title+day at DIFFERENT real venues stays in two components (fixture 10)", () => {
		const comps = planComponents([
			{
				id: 1,
				title: "X",
				start_at: 1790415000,
				venue: "Núcleo Sporting Clube de Portugal da Marinha Grande",
				city: "Marinha Grande",
			},
			{
				id: 2,
				title: "X",
				start_at: 1790415000,
				venue: "Hotel Cristal Praia, Praia da Vieira",
				city: "Marinha Grande",
			},
		]);
		expect(comps).toHaveLength(2);
	});

	test("vague-venue pair (Jornadas Europeias) merges into one component", () => {
		const comps = planComponents([
			{
				id: 1,
				title: "Jornadas Europeias do Património 2026",
				start_at: 1789718400,
				venue: "Vários Espaços Culturais",
				city: "Leiria",
			},
			{
				id: 2,
				title: "Jornadas Europeias do Património 2026",
				start_at: 1789718400,
				venue: "Leiria (cidade)",
				city: "Leiria",
			},
		]);
		expect(comps).toHaveLength(1);
		expect(comps[0]?.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
	});

	test("distinct titles never share a component", () => {
		const comps = planComponents([
			{
				id: 1,
				title: "A",
				start_at: 1000,
				venue: "Leiria (cidade)",
				city: "Leiria",
			},
			{
				id: 2,
				title: "B",
				start_at: 1000,
				venue: "Leiria (cidade)",
				city: "Leiria",
			},
		]);
		expect(comps).toHaveLength(2);
	});

	test("dayIdentityKey separates different Lisbon days", () => {
		const a = dayIdentityKey("X", 1789165800);
		const b = dayIdentityKey("X", 1789167600);
		expect(a).not.toBe(b);
	});
});

/**
 * Tier 1 duplicate shapes (real rows from the district ingest run). Each test
 * names the ids it came from so a future change that re-opens the pair is
 * traceable to the live data it broke.
 */
describe("venueCompatible parish-city wildcard (Tier 1)", () => {
	// 390 (viralagenda: hall + parish city) vs 684 (municipal agenda: concelho).
	test("vague concelho placeholder matches a specific venue in a district parish", () => {
		expect(
			venueCompatible(
				"Marinha Grande",
				"SBR 1º Janeiro",
				"Marinha Grande",
				"Ordem",
				1789686000,
				1789686000,
			),
		).toBe(true);
	});

	test("but never across municipalities, even at the same instant", () => {
		expect(
			venueCompatible(
				"Marinha Grande",
				"Mercado Municipal",
				"Marinha Grande",
				"Leiria",
				1789686000,
				1789686000,
			),
		).toBe(false);
	});

	test("and never for a different session", () => {
		expect(
			venueCompatible(
				"Marinha Grande",
				"SBR 1º Janeiro",
				"Marinha Grande",
				"Ordem",
				1789686000,
				1789686000 + 19 * 3600,
			),
		).toBe(false);
	});

	test("out-of-district cities never match, even at the same instant", () => {
		expect(
			venueCompatible(
				"Leiria (cidade)",
				"Mercado de Leiria",
				"Leiria",
				"Lisboa",
				1789686000,
				1789686000,
			),
		).toBe(false);
	});

	test("without start evidence the wildcard stays closed", () => {
		expect(
			venueCompatible(
				"Marinha Grande",
				"SBR 1º Janeiro",
				"Marinha Grande",
				"Ordem",
			),
		).toBe(false);
	});

	// 570 vs 730: "Óbidos (vila)" is the whole town, "Cerca do Castelo" is the
	// venue inside it. Before "vila" joined the generic tokens the placeholder
	// looked specific and the pair survived as two rows.
	test("a whole-town placeholder in parentheses is vague, not a venue", () => {
		expect(
			venueCompatible("Óbidos (vila)", "Cerca do Castelo", "Óbidos", "Óbidos"),
		).toBe(true);
	});
});

describe("planComponents on Tier 1 duplicate shapes", () => {
	test("municipal concelho placeholder + viralagenda hall in a parish = one component", () => {
		const comps = planComponents([
			{
				id: 390,
				title: "FESTA DA ORDEM'26",
				start_at: 1789686000,
				venue: "SBR 1º Janeiro",
				city: "Ordem",
			},
			{
				id: 684,
				title: "FESTA DA ORDEM'26",
				start_at: 1789686000,
				venue: "Marinha Grande",
				city: "Marinha Grande",
			},
		]);
		expect(comps).toHaveLength(1);
		expect(comps[0]?.map((r) => r.id).sort((a, b) => a - b)).toEqual([
			390, 684,
		]);
	});

	test("Óbidos Vila Natal ('(vila)' placeholder vs the castle) = one component", () => {
		const comps = planComponents([
			{
				id: 570,
				title: "Óbidos Vila Natal",
				start_at: 1795773600,
				venue: "Óbidos (vila)",
				city: "Óbidos",
			},
			{
				id: 730,
				title: "Óbidos Vila Natal",
				start_at: 1795737600,
				venue: "Cerca do Castelo",
				city: "Óbidos",
			},
		]);
		expect(comps).toHaveLength(1);
	});

	// 498 vs 625: both rows name a REAL venue in the same concelho (they are
	// different parishes). Conservative rule: stay separate — this is the
	// pre-existing viralagenda-vs-itself pair, not a Tier 1 regression.
	test("two specific venues in different parishes of one concelho stay separate", () => {
		const comps = planComponents([
			{
				id: 498,
				title: "10.º Aniversário",
				start_at: 1790415000,
				venue: "Núcleo Sporting Clube de Portugal da Marinha Grande",
				city: "Marinha Grande",
			},
			{
				id: 625,
				title: "10.º Aniversário",
				start_at: 1790415000,
				venue: "Praia da Vieira",
				city: "Vieira de Leiria",
			},
		]);
		expect(comps).toHaveLength(2);
	});

	// ...but the very same pair DOES fuse once the municipal agenda's
	// concelho-level row (vague "Marinha Grande") is in the group: it is
	// compatible with 498 (same city) AND with 625 (Vieira de Leiria is a
	// locality of Marinha Grande), so the component is transitive. Intentional:
	// the duplicate has to disappear, and the keeper keeps the descriptive
	// venue while the attributions merge.
	test("a vague concelho row bridges two specific parish venues (transitive)", () => {
		const comps = planComponents([
			{
				id: 498,
				title: "10.º Aniversário",
				start_at: 1790415000,
				venue: "Núcleo Sporting Clube de Portugal da Marinha Grande",
				city: "Marinha Grande",
			},
			{
				id: 625,
				title: "10.º Aniversário",
				start_at: 1790415000,
				venue: "Praia da Vieira",
				city: "Vieira de Leiria",
			},
			{
				id: 900,
				title: "10.º Aniversário",
				start_at: 1790415000,
				venue: "Marinha Grande",
				city: "Marinha Grande",
			},
		]);
		expect(comps).toHaveLength(1);
	});
});
