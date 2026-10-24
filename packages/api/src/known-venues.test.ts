import { describe, expect, test } from "bun:test";

import {
	KNOWN_LEIRIA_VENUES,
	knownVenueFor,
	titlePlaceCity,
} from "./known-venues";

describe("knownVenueFor", () => {
	test("matches a curated venue named inside a longer title", () => {
		expect(knownVenueFor("Baleia Baleia Baleia @ O Pica Miolos")?.city).toBe(
			"Leiria",
		);
		expect(knownVenueFor("Chimera Black @ O Pica Miolos")?.name).toBe(
			"O Pica Miolos",
		);
	});

	test("matches a bare name and an alias, whatever the case or accents", () => {
		expect(knownVenueFor("O Pica Miolos")?.city).toBe("Leiria");
		expect(knownVenueFor("  o pica miolos ")?.city).toBe("Leiria");
		expect(knownVenueFor("PICA MIOLOS")?.city).toBe("Leiria");
	});

	test("refuses what it cannot recognize", () => {
		expect(knownVenueFor("Sporting Clube de Leiria")).toBeNull();
		expect(knownVenueFor("Pica")).toBeNull(); // a partial name is not a venue
		expect(knownVenueFor("Miolos")).toBeNull();
		expect(knownVenueFor("")).toBeNull();
		expect(knownVenueFor("   ")).toBeNull();
		expect(knownVenueFor(null)).toBeNull();
		expect(knownVenueFor(undefined)).toBeNull();
	});

	test("every entry is a checkable fact: name, aliases, city, note", () => {
		for (const venue of KNOWN_LEIRIA_VENUES) {
			expect(venue.name.length).toBeGreaterThan(0);
			expect(venue.city.length).toBeGreaterThan(0);
			expect(venue.note.length).toBeGreaterThan(20);
		}
	});
});

describe("titlePlaceCity", () => {
	test("reads a municipality the title actually names", () => {
		expect(
			titlePlaceCity("ORFEU E EURÍDICE - FESTIVAL DE ÓPERA DE ÓBIDOS 2026"),
		).toBe("Óbidos");
		expect(
			titlePlaceCity("Caldas da Rainha Ladies Open - Caminhada Solidária"),
		).toBe("Caldas da Rainha");
		expect(titlePlaceCity("Feira de São Mateus da Marinha Grande")).toBe(
			"Marinha Grande",
		);
		expect(titlePlaceCity("ÁGORA regressa ao Castelo de Leiria")).toBe(
			"Leiria",
		);
	});

	test("multi-word municipalities need the whole phrase — 'porto' is not Porto de Mós", () => {
		expect(titlePlaceCity("Feira do Porto")).toBeNull();
		expect(titlePlaceCity("Meia maratona do Porto de Mós")).toBe(
			"Porto de Mós",
		);
		expect(titlePlaceCity("Festival do Vinhos")).toBeNull();
	});

	test("'pombal' and 'batalha' stay excluded — too generic in titles", () => {
		expect(titlePlaceCity("Concerto no Marquês de Pombal")).toBeNull();
		expect(titlePlaceCity("FESTIVAL DE ÓPERA DE POMBAL")).toBeNull();
		expect(titlePlaceCity("Batalha de Flores")).toBeNull();
		expect(titlePlaceCity("Recriação da Batalha")).toBeNull();
	});

	test("nothing to read", () => {
		expect(titlePlaceCity("CHIADO COMEDY CLUB | HUMOR NEGRO")).toBeNull();
		expect(titlePlaceCity("")).toBeNull();
		expect(titlePlaceCity(null)).toBeNull();
		expect(titlePlaceCity(undefined)).toBeNull();
	});
});
