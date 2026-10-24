import { describe, expect, test } from "bun:test";

import { venueLabels } from "./venue-label";

describe("venueLabels", () => {
	test("a name held by one venue stays bare", () => {
		const labels = venueLabels([
			{ slug: "teatro-jose-lucio", name: "Teatro José Lúcio", city: "Leiria" },
			{ slug: "cine-batalha", name: "Cine-Teatro", city: "Batalha" },
		]);
		expect(labels.get("teatro-jose-lucio")).toBe("Teatro José Lúcio");
		expect(labels.get("cine-batalha")).toBe("Cine-Teatro");
	});

	test("venues sharing a name get their town appended", () => {
		const labels = venueLabels([
			{ slug: "bib-batalha", name: "Biblioteca Municipal", city: "Batalha" },
			{ slug: "bib-pombal", name: "Biblioteca Municipal", city: "Pombal" },
			{ slug: "castelo", name: "Castelo de Leiria", city: "Leiria" },
		]);
		expect(labels.get("bib-batalha")).toBe("Biblioteca Municipal (Batalha)");
		expect(labels.get("bib-pombal")).toBe("Biblioteca Municipal (Pombal)");
		expect(labels.get("castelo")).toBe("Castelo de Leiria");
	});

	test("the town is the concelho the venue's city folds onto", () => {
		const labels = venueLabels([
			{ slug: "a", name: "Pavilhão Municipal", city: "Gaeiras" },
			{ slug: "b", name: "Pavilhão Municipal", city: "Pombal" },
		]);
		expect(labels.get("a")).toBe("Pavilhão Municipal (Óbidos)");
		expect(labels.get("b")).toBe("Pavilhão Municipal (Pombal)");
	});

	test("names compare without case or surrounding space", () => {
		const labels = venueLabels([
			{ slug: "a", name: "Biblioteca Municipal", city: "Batalha" },
			{ slug: "b", name: " biblioteca municipal ", city: "Pombal" },
		]);
		expect(labels.get("a")).toBe("Biblioteca Municipal (Batalha)");
		expect(labels.get("b")).toBe("biblioteca municipal (Pombal)");
	});

	test("a shared name with no known town stays bare", () => {
		const labels = venueLabels([
			{ slug: "a", name: "Biblioteca Municipal", city: "Batalha" },
			{ slug: "b", name: "Biblioteca Municipal", city: null },
		]);
		expect(labels.get("a")).toBe("Biblioteca Municipal (Batalha)");
		expect(labels.get("b")).toBe("Biblioteca Municipal");
	});

	test("the same venue listed twice (one row per event) counts once", () => {
		const labels = venueLabels([
			{ slug: "a", name: "Teatro Stephens", city: "Marinha Grande" },
			{ slug: "a", name: "Teatro Stephens", city: "Marinha Grande" },
		]);
		expect(labels.get("a")).toBe("Teatro Stephens");
	});
});
