import { describe, expect, test } from "bun:test";

import { fingerprint, fingerprintUndated } from "./fingerprint";
import { venueCompatible } from "./identity";
import {
	cityKey,
	pickVenue,
	sameVenue,
	UNKNOWN_CITY,
	type VenueRow,
} from "./venue-city";

const START = 1_900_000_000;

const row = (
	id: number,
	name: string,
	city: string,
	slug: string,
): VenueRow => ({ id, name, city, slug });

describe("cityKey (concelho-level town identity)", () => {
	test("parishes and spellings of one concelho share a key", () => {
		expect(cityKey("Batalha")).toBe("batalha");
		expect(cityKey("BATALHA")).toBe("batalha");
		expect(cityKey("Ordem")).toBe(cityKey("Marinha Grande"));
		expect(cityKey("Marrazes")).toBe("leiria");
		expect(cityKey("Leiria e arredores")).toBe("leiria");
		expect(cityKey("Leiria (cidade)")).toBe("leiria");
	});
	test("different concelhos never share a key", () => {
		expect(cityKey("Batalha")).not.toBe(cityKey("Pombal"));
		expect(cityKey("Leiria")).not.toBe(cityKey("Marinha Grande"));
	});
	test("no town is the empty key, including the district placeholder", () => {
		expect(cityKey(null)).toBe("");
		expect(cityKey("  ")).toBe("");
		expect(cityKey("N/D")).toBe("");
		expect(cityKey(UNKNOWN_CITY)).toBe("");
	});
	test("an unplaceable locality keys on its own name", () => {
		expect(cityKey("Lisboa")).toBe("lisboa");
	});
});

describe("fingerprint carries the venue's town (C3)", () => {
	test("same title, time and venue NAME in two towns hash apart", () => {
		const batalha = fingerprint(
			"Concerto",
			"Biblioteca Municipal",
			START,
			"Batalha",
		);
		const pombal = fingerprint(
			"Concerto",
			"Biblioteca Municipal",
			START,
			"Pombal",
		);
		expect(batalha).not.toBe(pombal);
		expect(
			fingerprintUndated("Feira", "Mercado Municipal", "Batalha"),
		).not.toBe(fingerprintUndated("Feira", "Mercado Municipal", "Pombal"));
	});
	test("spellings of the same town hash together", () => {
		expect(fingerprint("Concerto", "Cine-Teatro", START, "Ordem")).toBe(
			fingerprint("Concerto", "Cine-Teatro", START, "Marinha Grande"),
		);
		expect(fingerprint("Concerto", "Cine-Teatro", START, "BATALHA")).toBe(
			fingerprint("Concerto", "Cine-Teatro", START, "Batalha"),
		);
	});
	test("an unknown town keeps the pre-C3 fingerprint exactly", () => {
		const legacy = fingerprint("Concerto", "Teatro Miguel Franco", START);
		expect(fingerprint("Concerto", "Teatro Miguel Franco", START, null)).toBe(
			legacy,
		);
		expect(
			fingerprint("Concerto", "Teatro Miguel Franco", START, UNKNOWN_CITY),
		).toBe(legacy);
		expect(
			fingerprint("Concerto", "Teatro Miguel Franco", START, "Leiria"),
		).not.toBe(legacy);
	});
});

describe("pickVenue (venue = name + town)", () => {
	const leiria = row(
		1,
		"Biblioteca Municipal",
		"Leiria",
		"biblioteca-municipal",
	);

	test("the same name in a new town creates a town-qualified row", () => {
		const pick = pickVenue("Biblioteca Municipal", "Batalha", [leiria]);
		expect(pick).toEqual({
			kind: "create",
			name: "Biblioteca Municipal",
			city: "Batalha",
			slug: "biblioteca-municipal-batalha",
		});
	});
	test("the first town to use a name keeps the plain slug", () => {
		expect(pickVenue("Biblioteca Municipal", "Batalha", [])).toMatchObject({
			kind: "create",
			slug: "biblioteca-municipal",
		});
	});
	test("same name in the same town (any spelling of it) reuses the row", () => {
		expect(pickVenue("Biblioteca Municipal", "Leiria", [leiria])).toEqual({
			kind: "use",
			id: 1,
		});
		expect(pickVenue("Biblioteca  Municipal", "Marrazes", [leiria])).toEqual({
			kind: "use",
			id: 1,
		});
		const qualified = row(
			2,
			"Biblioteca Municipal",
			"Batalha",
			"biblioteca-municipal-batalha",
		);
		expect(
			pickVenue("Biblioteca Municipal", "BATALHA", [leiria, qualified]),
		).toEqual({
			kind: "use",
			id: 2,
		});
	});
	test("a spelling variant in the same town reuses the row (normalized city, C12)", () => {
		const blackBox = row(
			3,
			"Black Box - Plataforma de Criação Artística",
			"Leiria",
			"black-box-plataforma-de-criacao-artistica",
		);
		expect(pickVenue("BLACK BOX", "leiria", [blackBox])).toEqual({
			kind: "use",
			id: 3,
		});
		expect(pickVenue("BLACK BOX", "Batalha", [blackBox]).kind).toBe("create");
	});
	test("a town-qualified slug that is taken gets a numeric suffix", () => {
		const odd = row(
			4,
			"Biblioteca Municipal Batalha",
			"Lisboa",
			"biblioteca-municipal-batalha",
		);
		expect(
			pickVenue("Biblioteca Municipal", "Batalha", [leiria, odd]),
		).toMatchObject({
			kind: "create",
			slug: "biblioteca-municipal-batalha-2",
		});
	});

	describe("unknown town (null-city policy)", () => {
		test("borrows a same-named row only when the name is unambiguous", () => {
			expect(pickVenue("Biblioteca Municipal", null, [leiria])).toEqual({
				kind: "use",
				id: 1,
			});
		});
		test("an ambiguous name goes to the shared unknown-town row, never a guessed town", () => {
			const batalha = row(
				2,
				"Biblioteca Municipal",
				"Batalha",
				"biblioteca-municipal-batalha",
			);
			expect(
				pickVenue("Biblioteca Municipal", null, [leiria, batalha]),
			).toEqual({
				kind: "create",
				name: "Biblioteca Municipal",
				city: UNKNOWN_CITY,
				slug: "biblioteca-municipal-distrito",
			});
			const bucket = row(
				5,
				"Biblioteca Municipal",
				UNKNOWN_CITY,
				"biblioteca-municipal-distrito",
			);
			expect(
				pickVenue("Biblioteca Municipal", null, [leiria, batalha, bucket]),
			).toEqual({
				kind: "use",
				id: 5,
			});
		});
		test("a never-seen name is created under the district placeholder", () => {
			expect(pickVenue("Sala Nova", null, [])).toEqual({
				kind: "create",
				name: "Sala Nova",
				city: UNKNOWN_CITY,
				slug: "sala-nova",
			});
		});
		test("a known town adopts a same-named row that has no town yet", () => {
			const bucket = row(
				6,
				"Teatro Miguel Franco",
				UNKNOWN_CITY,
				"teatro-miguel-franco",
			);
			expect(pickVenue("Teatro Miguel Franco", "Leiria", [bucket])).toEqual({
				kind: "use",
				id: 6,
				setCity: "Leiria",
			});
		});
		test("…but not when another town already owns the name", () => {
			const bucket = row(
				5,
				"Biblioteca Municipal",
				UNKNOWN_CITY,
				"biblioteca-municipal-distrito",
			);
			expect(
				pickVenue("Biblioteca Municipal", "Pombal", [leiria, bucket]),
			).toMatchObject({
				kind: "create",
				city: "Pombal",
				slug: "biblioteca-municipal-pombal",
			});
		});
	});
});

describe("venue-row merge equivalence respects the town", () => {
	test("same name, different towns: two venues", () => {
		expect(
			sameVenue(
				row(1, "Mercado Municipal", "Batalha", "mercado-municipal"),
				row(2, "Mercado Municipal", "Pombal", "mercado-municipal-pombal"),
			),
		).toBe(false);
	});
	test("spelling variants in one town: one venue", () => {
		expect(
			sameVenue(
				row(1, "Mercado de Leiria", "Leiria", "mercado-de-leiria"),
				row(
					2,
					"Mercado Municipal de Leiria",
					"Leiria",
					"mercado-municipal-de-leiria",
				),
			),
		).toBe(true);
	});
});

describe("event identity wildcard respects the town", () => {
	test("two placeholders in different towns are different announcements", () => {
		expect(
			venueCompatible(
				"Vários Espaços Culturais",
				"Vários Espaços Culturais",
				"Batalha",
				"Pombal",
			),
		).toBe(false);
		expect(
			venueCompatible(
				"Vários Espaços Culturais",
				"Batalha (vila)",
				"Batalha",
				"Batalha",
			),
		).toBe(true);
		expect(
			venueCompatible(
				"Vários Espaços Culturais",
				"Vários Espaços Culturais",
				"Batalha",
				UNKNOWN_CITY,
			),
		).toBe(true);
	});
	test("same-named specific venues in different towns never fuse", () => {
		expect(
			venueCompatible(
				"Biblioteca Municipal",
				"Biblioteca Municipal",
				"Batalha",
				"Pombal",
			),
		).toBe(false);
	});
});
