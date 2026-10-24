import { describe, expect, test } from "bun:test";

import {
	decodeEntities,
	detectFree,
	isVagueVenue,
	normalizeCity,
	normalizeTitle,
	normalizeVenueName,
	slugify,
	venuesMatch,
	venueTokens,
} from "./normalize";

describe("normalizeTitle", () => {
	test("lowercases", () => {
		expect(normalizeTitle("Tattoo Artes")).toBe("tattoo artes");
	});
	test("strips diacritics", () => {
		expect(normalizeTitle("José Cláudio em Leiria")).toBe(
			"jose claudio em leiria",
		);
	});
	test("strips punctuation and collapses spaces", () => {
		expect(normalizeTitle("  A   Memória! — do Cheiro  ")).toBe(
			"a memoria do cheiro",
		);
	});
});

describe("normalizeVenueName + slugify", () => {
	test("Mercado de Sant'Ana resolves to the seed venue slug", () => {
		const name = normalizeVenueName("Centro Cultural Mercado de Sant'Ana");
		expect(name).toBe("Mercado de Sant'Ana");
		expect(slugify(name)).toBe("mercado-de-santana");
	});
	test("gallery prefix strips to the library seed slug", () => {
		expect(
			slugify(
				normalizeVenueName(
					"Galeria de Arte da Biblioteca Municipal Afonso Lopes Vieira",
				),
			),
		).toBe("biblioteca-municipal-afonso-lopes-vieira");
	});
	test("slugify handles plain venue", () => {
		expect(slugify("Teatro José Lúcio da Silva")).toBe(
			"teatro-jose-lucio-da-silva",
		);
	});
});

describe("normalizeCity", () => {
	test("drops parenthetical scope and diacritics", () => {
		expect(normalizeCity("Leiria (distrito)")).toBe("leiria");
		expect(normalizeCity("Leiria")).toBe("leiria");
		expect(normalizeCity("Marinha Grande")).toBe("marinha grande");
	});
	test("null/undefined collapse to empty", () => {
		expect(normalizeCity(null)).toBe("");
		expect(normalizeCity(undefined)).toBe("");
	});
	test("scope fillers drop, so 'e arredores' equals the bare city", () => {
		expect(normalizeCity("Leiria e arredores")).toBe("leiria");
		expect(normalizeCity("Concelho de Leiria")).not.toBe("leiria");
		// Meaningful words are never stripped: only scope fillers are.
		expect(normalizeCity("Vieira de Leiria")).toBe("vieira de leiria");
	});
});

describe("venueTokens", () => {
	test("drops stopwords, generics, short and city tokens", () => {
		expect(
			venueTokens(
				"Black Box - Plataforma de Criação Artística de Leiria",
				"Leiria",
			),
		).toEqual(["artistica", "black", "box", "criacao", "plataforma"]);
	});
	test("Mercado de Leiria keeps only its discriminating token", () => {
		expect(venueTokens("Mercado de Leiria", "Leiria")).toEqual(["mercado"]);
	});
});

describe("isVagueVenue", () => {
	test("city/district placeholders are vague", () => {
		expect(isVagueVenue("Concelho de Leiria", "Leiria")).toBe(true);
		expect(isVagueVenue("Leiria (cidade)", "Leiria")).toBe(true);
		expect(isVagueVenue("Vários Espaços Culturais", "Leiria")).toBe(true);
	});
	test("Leiria (cidade) stays vague with no city passed", () => {
		expect(isVagueVenue("Leiria (cidade)", null)).toBe(true);
	});
	test("a real venue is not vague", () => {
		expect(isVagueVenue("Mercado de Leiria", "Leiria")).toBe(false);
		expect(
			isVagueVenue("Biblioteca Municipal Afonso Lopes Vieira", "Leiria"),
		).toBe(false);
	});
});

describe("venuesMatch (strict cross-source venue identity)", () => {
	const L = "Leiria";
	test("BLACK BOX matches its long-form canonical name (both directions)", () => {
		const box = "BLACK BOX";
		const full = "Black Box - Plataforma de Criação Artística de Leiria";
		expect(venuesMatch(box, full, L, L)).toBe(true);
		expect(venuesMatch(full, box, L, L)).toBe(true);
	});
	test("Black Box Leiria matches BLACK BOX", () => {
		expect(venuesMatch("Black Box Leiria", "BLACK BOX", L, L)).toBe(true);
	});
	test("library matches its - Leiria suffix variant", () => {
		expect(
			venuesMatch(
				"Biblioteca Municipal Afonso Lopes Vieira",
				"Biblioteca Municipal Afonso Lopes Vieira - Leiria",
				L,
				L,
			),
		).toBe(true);
	});
	test("Mercado de Leiria is a subset of Mercado Municipal de Leiria", () => {
		expect(
			venuesMatch("Mercado de Leiria", "Mercado Municipal de Leiria", L, L),
		).toBe(true);
	});
	test("theatre matches its (Leiria) suffix variant", () => {
		expect(
			venuesMatch(
				"Teatro José Lúcio da Silva",
				"Teatro José Lúcio Da Silva (Leiria)",
				L,
				L,
			),
		).toBe(true);
	});
	test("intercultural centre matches its church variant", () => {
		expect(
			venuesMatch(
				"Centro de Diálogo Intercultural de Leiria - Igreja da Misericórdia",
				"Centro De Diálogo Intercultural De Leiria",
				L,
				L,
			),
		).toBe(true);
	});
	test("different venues do NOT match (subset, never overlap)", () => {
		expect(
			venuesMatch("Mercado de Leiria", "Teatro José Lúcio da Silva", L, L),
		).toBe(false);
	});
	test("same-name venues in different cities do NOT match", () => {
		expect(
			venuesMatch("Mercado de Leiria", "Mercado de Leiria", L, "Lisboa"),
		).toBe(false);
	});
	test("two different venues with the same title+day stay separate (fixture 10)", () => {
		expect(
			venuesMatch(
				"Núcleo Sporting Clube de Portugal da Marinha Grande",
				"Hotel Cristal Praia, Praia da Vieira",
				"Marinha Grande",
				"Marinha Grande",
			),
		).toBe(false);
	});
});

describe("decodeEntities (single canonical table)", () => {
	test("decodes named entities every source needs, not just the latin-1 core", () => {
		expect(decodeEntities("Ol&#x27; Obidos")).toBe("Ol' Obidos");
		expect(decodeEntities("&ecirc; &auml; &agrave; &ocirc; &acirc;")).toBe(
			"ê ä à ô â",
		);
		expect(decodeEntities("1&ordf; lugar &ordm;2")).toBe("1ª lugar º2");
		expect(decodeEntities("&lsquo;aspas&rsquo; &laquo;x&raquo;")).toBe(
			"‘aspas’ «x»",
		);
	});

	test("uppercase hex numeric entities decode (municipal parity)", () => {
		expect(decodeEntities("O&#X2019;Neill")).toBe("O’Neill");
	});

	test("out-of-range codepoints never throw, they stay verbatim", () => {
		// RangeError from String.fromCodePoint used to escape scrape() and kill
		// the whole district batch (municipal guarded this, the shared table did
		// not until every source moved onto it).
		expect(() => decodeEntities("x&#999999999;y")).not.toThrow();
		expect(decodeEntities("x&#999999999;y")).toBe("x&#999999999;y");
		expect(decodeEntities("x&#x110000;y")).toBe("x&#x110000;y");
		expect(decodeEntities("x&#0;y")).toBe("x&#0;y");
	});

	test("astral characters survive as hex, decimal and UTF-16 surrogate-half entities", () => {
		// cm-leiria's feed emits emoji both ways; the surrogate halves arrive as
		// two numeric entities and must re-join (the old private decoder's job).
		expect(decodeEntities("&#x1F4CC;")).toBe("📌");
		expect(decodeEntities("&#128204;")).toBe("📌");
		expect(decodeEntities("&#55357;&#56524;")).toBe("📌");
	});

	test("strips the hydration comments and leaves real ampersands alone", () => {
		expect(decodeEntities("set<!-- -->.")).toBe("set.");
		expect(decodeEntities("Le Raincy & Foz do Arelho")).toBe(
			"Le Raincy & Foz do Arelho",
		);
	});
});

describe("detectFree", () => {
	test("free-entry phrasing is true, any case or accent", () => {
		for (const text of [
			"Entrada livre",
			"ENTRADA GRATUITA",
			"Concerto gratuito no jardim",
			"Espetáculo grátis",
			"Acesso livre ao recinto",
			"Free entry",
			"entrada gratis",
			"Atividade gratuita.",
		]) {
			expect(detectFree(text)).toBe(true);
		}
	});

	test("no signal is null, never false", () => {
		for (const text of [
			"Bilhetes a 10 euros",
			"Concerto de verão",
			"Entrada: 5€",
			"",
			null,
			undefined,
		]) {
			expect(detectFree(text)).toBeNull();
		}
	});

	test("is word-bounded", () => {
		expect(detectFree("Gratuitamente")).toBeNull();
		expect(detectFree("Nogratuito")).toBeNull();
		expect(detectFree("pregratis")).toBeNull();
	});

	test("a preceding negation does not count", () => {
		expect(detectFree("não é gratuito")).toBeNull();
		expect(detectFree("Este evento não é gratuito.")).toBeNull();
		expect(detectFree("Nao tem entrada livre")).toBeNull();
		expect(detectFree("sem entrada gratuita")).toBeNull();
	});

	test("a free extra is not a free event", () => {
		expect(detectFree("Concerto 10€. Estacionamento gratuito.")).toBeNull();
		expect(detectFree("Wi-Fi grátis")).toBeNull();
	});

	test("free for some only is not a free event", () => {
		expect(detectFree("Entrada gratuita para menores de 6 anos")).toBeNull();
		expect(detectFree("Gratuito até aos 12 anos")).toBeNull();
		expect(detectFree("Entrada livre para todos")).toBe(true);
	});

	test("a later sentence can still make it free", () => {
		expect(detectFree("Não é gratuito para adultos. Entrada livre.")).toBe(
			true,
		);
		expect(detectFree("Estacionamento gratuito. Entrada livre.")).toBe(true);
	});
});
