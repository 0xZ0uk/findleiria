import { describe, expect, test } from "bun:test";

import {
	DISTRICT_MUNICIPALITIES,
	municipalityOf,
	normalizePlace,
	scopeOfName,
} from "./places";

describe("normalizePlace", () => {
	test("strips diacritics, case, dashes, extra spaces", () => {
		expect(normalizePlace("Caldas da Rainha")).toBe("caldas da rainha");
		expect(normalizePlace("caldas-da-rainha")).toBe("caldas da rainha");
		expect(normalizePlace("  PEDRÓGÃO   Grande ")).toBe("pedrogao grande");
		expect(normalizePlace("Mira d'Aire")).toBe("mira d'aire");
	});
});

describe("the district roster", () => {
	test("is the 16 municipalities of Distrito de Leiria", () => {
		expect(DISTRICT_MUNICIPALITIES.length).toBe(16);
		expect(new Set(DISTRICT_MUNICIPALITIES).size).toBe(16);
	});

	test("includes Ansião and Peniche", () => {
		// Both were missing and both have a configured municipal source, so
		// every event they parsed was gated out on `city`.
		expect(DISTRICT_MUNICIPALITIES).toContain("Ansião");
		expect(DISTRICT_MUNICIPALITIES).toContain("Peniche");
	});
});

describe("municipalityOf", () => {
	test("a município resolves to itself, in any spelling", () => {
		expect(municipalityOf("Óbidos")).toBe("Óbidos");
		expect(municipalityOf("obidos")).toBe("Óbidos");
		expect(municipalityOf("CALDAS DA RAINHA")).toBe("Caldas da Rainha");
		expect(municipalityOf("porto-de-mos")).toBe("Porto de Mós");
	});

	test("a freguesia resolves to its município", () => {
		expect(municipalityOf("Marrazes")).toBe("Leiria");
		expect(municipalityOf("Barreira")).toBe("Leiria");
		expect(municipalityOf("Carvide")).toBe("Leiria");
		expect(municipalityOf("Gaeiras")).toBe("Óbidos");
		expect(municipalityOf("Ordem")).toBe("Marinha Grande");
		expect(municipalityOf("São Pedro de Moel")).toBe("Marinha Grande");
		expect(municipalityOf("Calvaria de Cima")).toBe("Porto de Mós");
		expect(municipalityOf("Mira de Aire")).toBe("Porto de Mós");
		expect(municipalityOf("Alfeizerão")).toBe("Alcobaça");
		expect(municipalityOf("Benedita")).toBe("Alcobaça");
	});

	test("both spellings of the same place fold together", () => {
		expect(municipalityOf("Mira d'Aire")).toBe(municipalityOf("Mira de Aire"));
		expect(municipalityOf("Castanheira de Pêra")).toBe(
			municipalityOf("Castanheira de Pera"),
		);
	});

	test("returns null instead of guessing", () => {
		expect(municipalityOf("Lisboa")).toBeNull();
		expect(municipalityOf("Tomar")).toBeNull();
		expect(municipalityOf("")).toBeNull();
		expect(municipalityOf(null)).toBeNull();
		expect(municipalityOf(undefined)).toBeNull();
	});
});

/**
 * The concelho facet used to list 36 options for a 16-concelho district: every
 * freguesia a source reported as `city` became its own concelho, which split
 * Leiria's events across 10 values and offered "Óbidos" next to "Gaeiras".
 *
 * These are the exact city values the live database held (with how many events
 * each carried) when the fold shipped. Every one of them must land on a
 * município — a null here means the dropdown grows a new fake concelho.
 */
const LIVE_CITY_VALUES: readonly string[] = [
	"Leiria",
	"Óbidos",
	"Marinha Grande",
	"Alcobaça",
	"Caldas da Rainha",
	"Pombal",
	"Nazaré",
	"Bombarral",
	"Porto de Mós",
	"Peniche",
	"Alvaiázere",
	"Marrazes",
	"Figueiró dos Vinhos",
	"Colmeias",
	"Castanheira de Pera",
	"Caranguejeira",
	"Batalha",
	"Pedrógão Grande",
	"Milagres",
	"Carreira",
	"São Pedro de Moel",
	"Serro Ventoso",
	"Santa Eufémia",
	"Ordem",
	"Mira de Aire",
	"Mira d'Aire",
	"Gaeiras",
	"Cortes",
	"Castanheira de Pêra",
	"Carvide",
	"Calvaria de Cima",
	"Benedita",
	"Barreira",
	"Arrimal",
	"Alvados",
	"Alfeizerão",
	// Second pass (2026-09-12): labels live VENUE rows carried, which the first
	// list missed. Every one of these showed up as a 17th concelho in the facet
	// because the gate knew about some of them ("Leira") and the fold table did
	// not. Verified against the município that owns each place.
	"Juncal", // vila/freguesia of Porto de Mós
	"São Jorge", // povoação of Calvaria de Cima, Porto de Mós (the CIBA)
	"Valado dos Frades", // Nazaré
	"Tremoceira", // Alcobaça (Cister FM files by worked place)
	"Leira", // the leiriagenda typo for Leiria
	"Leiria e arredores", // a source's district-level catch-all
];

/**
 * Labels that are NOT the district's, kept visible on purpose. "Oleiros" is a
 * concelho in Castelo Branco that a source attached to one venue ("Mosteiro,
 * Mosteiro") — the fold must not claim it, and the event it carried is a source
 * leak to report, not a place to relabel.
 */
const OUTSIDE_CITY_VALUES: readonly string[] = ["Oleiros", "Mafra", "Oeiras"];

describe("the concelho facet", () => {
	test("every city value in the live database folds onto a município", () => {
		const unfolded = LIVE_CITY_VALUES.filter(
			(city) => municipalityOf(city) === null,
		);
		expect(unfolded).toEqual([]);
	});

	test("the fold only ever yields real district municipalities", () => {
		const folded = new Set(
			LIVE_CITY_VALUES.map((city) => municipalityOf(city)),
		);
		for (const municipality of folded) {
			if (municipality === null) continue;
			expect(DISTRICT_MUNICIPALITIES).toContain(municipality);
		}
	});

	test("freguesias stop being concelhos: Leiria survives as one option", () => {
		const leiria = LIVE_CITY_VALUES.filter(
			(city) => municipalityOf(city) === "Leiria",
		);
		// The 10 freguesias that used to be separate concelhos.
		expect(leiria).toContain("Marrazes");
		expect(leiria).toContain("Barreira");
		expect(leiria).toContain("Colmeias");
		expect(leiria).toContain("Caranguejeira");
		expect(leiria).toContain("Carvide");
		expect(leiria.length).toBeGreaterThan(1);
	});

	test("labels that are not the district's never fold into it", () => {
		for (const city of OUTSIDE_CITY_VALUES) {
			expect(municipalityOf(city)).toBeNull();
		}
	});
});

/**
 * Venue names from the live rows that had no coordinates. A source that never
 * located an event files it under the place, and the place arrives looking like
 * a venue: "Óbidos" (113 events), "Marinha Grande, Marinha Grande",
 * "Vieira de Leiria", "Marinha Grande &#x2F; Marinha Grande".
 *
 * Scope is what stops those from ever being drawn as a pin, so these are the
 * assertions that matter: a município is an area, a listed freguesia is a dot,
 * and a real venue — even one with a place in its name — stays a venue.
 */
describe("scopeOfName", () => {
	test("a município is an area, however the source spelled it", () => {
		expect(scopeOfName("Óbidos")).toBe("concelho");
		expect(scopeOfName("Leiria")).toBe("concelho");
		expect(scopeOfName("Alcobaça (cidade)")).toBe("concelho");
		expect(scopeOfName("Marinha Grande, Marinha Grande")).toBe("concelho");
		expect(scopeOfName("Marinha Grande &#x2F; Marinha Grande")).toBe(
			"concelho",
		);
		// The source's spelling, without the circumflex, still folds.
		expect(scopeOfName("Castanheira de Pera")).toBe("concelho");
	});

	test("a listed freguesia or vila is a dot, not a building", () => {
		expect(scopeOfName("Vieira de Leiria")).toBe("lugar");
		expect(scopeOfName("Colmeias")).toBe("lugar");
		expect(scopeOfName("São Pedro de Moel")).toBe("lugar");
		expect(scopeOfName("Benedita (Vila)")).toBe("lugar");
		expect(scopeOfName("São Bento (Porto de Mós)")).toBe("lugar");
		expect(scopeOfName("Bidoeira de Cima, Bidoeira de Cima")).toBe("lugar");
	});

	test("a real venue stays a venue, place name and all", () => {
		expect(scopeOfName("BLACK BOX")).toBe("venue");
		expect(scopeOfName("Castelo de Porto de Mós")).toBe("venue");
		expect(scopeOfName("Museu Escolar de Marrazes")).toBe("venue");
		expect(scopeOfName("Teatro Eduardo Brazão")).toBe("venue");
		expect(
			scopeOfName("CCC Centro Cultural e de Congressos das Caldas da Rainha"),
		).toBe("venue");
	});

	test("a source label is not a place anyone can stand in", () => {
		// Both are real rows: one is the source's own name, the other says
		// outright that the event happens across the whole city.
		expect(scopeOfName("Agenda Cultural Óbidos")).toBe("venue");
		expect(scopeOfName("Vários Locais da Cidade de Leiria")).toBe("venue");
	});

	test("an unlisted lugar stays a venue rather than being guessed", () => {
		// Moleanos is a lugar of Alcobaça that the table does not list. Rather
		// than invent a category, the name reads as a venue; the geocoder then
		// downgrades it to `lugar` when OSM answers with a settlement and not a
		// building, which is the only place that judgement can honestly be
		// made.
		expect(scopeOfName("Moleanos (Alcobaça)")).toBe("venue");
	});

	test("the district catch-all and the typo read as areas, not as rooms", () => {
		expect(scopeOfName("Leiria e arredores")).toBe("concelho");
		expect(scopeOfName("Leira")).toBe("concelho");
		expect(scopeOfName("Juncal (Porto de Mós)")).toBe("lugar");
	});
});
