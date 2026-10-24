import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { must } from "../test-helpers";
import {
	DESCRIPTION_LIMIT,
	extractDate,
	extractVenue,
	parseFeed,
	scrape,
} from "./cmleiriarss";
import { fingerprint, fingerprintUndated, lisbonDay } from "./fingerprint";

const fixture = readFileSync(
	new URL("./__fixtures__/rss-eventos.xml", import.meta.url),
	"utf-8",
);

describe("parseFeed (offline fixture)", () => {
	test("parses >=25 items (fixture holds 31)", () => {
		const events = parseFeed(fixture);
		expect(events.length).toBeGreaterThanOrEqual(25);
	});

	test("every dated item has a non-null startAt and no dateText", () => {
		const events = parseFeed(fixture);
		const dated = events.filter((e) => e.startAt != null);
		expect(dated.length).toBeGreaterThanOrEqual(25);
		for (const e of dated) {
			expect(e.dateText).toBeNull();
		}
	});

	test("Colóquio date-from-text: 1 fevereiro => day 1, month 2, non-null epoch", () => {
		const ev = must(
			parseFeed(fixture).find((e) => e.slug === "coloquio-prevencao-de-quedas"),
		);
		expect(ev.startAt).not.toBeNull();
		const day = lisbonDay(must(ev.startAt));
		// month+day always 02-01 regardless of the current/next year rule.
		expect(day.slice(5)).toBe("02-01");
		const parsed = must(
			extractDate(
				"A atividade física na redução do risco de quedas. 1 fevereiro às 14h30",
			),
		);
		expect(parsed.day).toBe(1);
		expect(parsed.month).toBe(2);
		expect(parsed.hour).toBe(14);
		expect(parsed.minute).toBe(30);
	});

	test("undated item keeps startAt null and dateText non-null (still ingested)", () => {
		const ev = must(
			parseFeed(fixture).find(
				(e) => e.slug === "dialogo-aberto-envelhecimento-ativo",
			),
		);
		expect(ev.startAt).toBeNull();
		expect(ev.dateText).not.toBeNull();
		expect(must(ev.dateText).toLowerCase()).toContain("janeiro");
	});

	test("pseudo-categories are excluded, real categories survive", () => {
		const events = parseFeed(fixture);
		const all = events.flatMap((e) => e.categories);
		expect(all).not.toContain("Evento");
		expect(all).not.toContain("Homepage | Agenda");
		expect(all).not.toContain("Newsletter | Evento Destaque");
		expect(all).not.toContain("Newsletter | Eventos Listagem");
		expect(all).toContain("Música");
		expect(all).toContain("Teatro");
		expect(all).toContain("Exposições");
	});

	test("venue extracted from the 📌/📍 line", () => {
		const events = parseFeed(fixture);
		const coll = must(
			events.find((e) => e.slug === "coloquio-prevencao-de-quedas"),
		);
		expect(coll.venueName.toLowerCase()).toContain(
			"auditório do estádio dr. magalhães pessoa",
		);
		const quinta = must(
			events.find((e) => e.slug === "visita-a-vinha-biologica-prova-de-vinhos"),
		);
		expect(quinta.venueName.toLowerCase()).toContain("quinta da serradinha");
	});

	test("default venue for an item without a venue hint", () => {
		const ev = must(
			parseFeed(fixture).find(
				(e) => e.slug === "dialogo-aberto-envelhecimento-ativo",
			),
		);
		expect(ev.venueName).toBe("CM Leiria");
	});

	test("description is stripped text and bounded to DESCRIPTION_LIMIT", () => {
		const events = parseFeed(fixture);
		for (const e of events) {
			expect(e.description?.length ?? 0).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
			expect(e.description ?? "").not.toContain("<");
		}
	});

	test("imageUrl extracted from the trailing <img>", () => {
		const ev = must(
			parseFeed(fixture).find((e) => e.slug === "coloquio-prevencao-de-quedas"),
		);
		expect(ev.imageUrl).toBe(
			"https://www.cm-leiria.pt/cmleiria/uploads/event/image/6379/coloquio_prevencao_de_quedas.jpg",
		);
	});
});

describe("extractDate (unit)", () => {
	test("Portuguese month names + às HHhMM", () => {
		const d = extractDate("21 de janeiro às 21h30");
		expect(d?.day).toBe(21);
		expect(d?.month).toBe(1);
		expect(d?.hour).toBe(21);
		expect(d?.minute).toBe(30);
	});
	test("multi-day list picks the first day (dias 1 e 2 de março)", () => {
		const d = extractDate("dias 1 e 2 de março às 18h00");
		expect(d?.day).toBe(1);
		expect(d?.month).toBe(3);
	});
	test("numeric dd/mm/yyyy", () => {
		const d = extractDate("12/03/2026 às 20h00");
		expect(d?.day).toBe(12);
		expect(d?.month).toBe(3);
		expect(d?.year).toBe(2026);
	});
	test("short text date 12 mar 2026", () => {
		const d = extractDate("12 mar 2026");
		expect(d?.day).toBe(12);
		expect(d?.month).toBe(3);
		expect(d?.year).toBe(2026);
	});
	test("no date pattern => null", () => {
		expect(
			extractDate("Sessão aberta à comunidade para partilhar ideias."),
		).toBeNull();
	});
});

describe("extractVenue (unit)", () => {
	test("📌-prefixed venue", () => {
		expect(
			extractVenue(
				"📌Auditório do Estádio Dr. Magalhães Pessoa (porta 7) Inscrição gratuita",
			),
		).toContain("Auditório do Estádio Dr. Magalhães Pessoa");
	});
	test("Local: pattern", () => {
		expect(
			extractVenue("Conferência às 15h Local: Teatro Miguel Franco"),
		).toContain("Teatro Miguel Franco");
	});
	test("default CM Leiria", () => {
		expect(extractVenue("Sessão aberta com horário a confirmar")).toBe(
			"CM Leiria",
		);
	});
});

describe("scrape resilience (mock deps, offline)", () => {
	test("returns 31 events from the fixture feed", async () => {
		const result = await scrape({ fetchText: async () => fixture });
		expect(result.failures).toBe(0);
		expect(result.firstError).toBeNull();
		expect(result.events.length).toBe(31);
	});
	test("a feed that fails to load bubbles the error", async () => {
		let called = 0;
		await expect(
			scrape({
				fetchText: async () => {
					called++;
					throw new Error("GET -> HTTP 500");
				},
			}),
		).rejects.toThrow("HTTP 500");
		expect(called).toBe(1);
	});
});

describe("impossible dates (S2)", () => {
	const item = (slug: string, when: string) => `<item>
      <title>Evento ${slug}</title>
      <description>&lt;p&gt;${when}&lt;/p&gt;&lt;p&gt;📌Teatro Miguel Franco&lt;/p&gt;</description>
      <pubDate>Mon, 05 Oct 2026 10:00:00 +0000</pubDate>
      <link>https://www.cm-leiria.pt/evento/${slug}</link>
    </item>`;
	const feed = `<rss><channel>${item("bom-1", "12 de novembro de 2026 às 21h30")}${item("mau", "31 de fevereiro de 2027 às 21h30")}${item("bom-2", "14 de novembro de 2026 às 18h00")}</channel></rss>`;

	test("parseEvent never throws on 31 de fevereiro; returns null", () => {
		expect(() => parseFeed(feed)).not.toThrow();
		expect(parseFeed(feed).map((e) => e.slug)).toEqual(["bom-1", "bom-2"]);
	});

	test("scrape skips only the bad item and counts it as a failure", async () => {
		const result = await scrape({ fetchText: async () => feed });
		expect(result.events.map((e) => e.slug)).toEqual(["bom-1", "bom-2"]);
		expect(result.failures).toBe(1);
		expect(result.firstError).not.toBeNull();
	});
});

describe("entity decoding (canonical decoder, feed double-escaping)", () => {
	// The feed XML-escapes an HTML document, so every entity arrives escaped
	// twice; curly quotes fold to the straight ones this feed has always used.
	const feed = `<rss><channel><item>
      <title>Concerto &amp;amp; Festa &amp;#8220;Aberta&amp;#8221; d&amp;#8217;Avó &amp;#55357;&amp;#56524;</title>
      <description>&lt;p&gt;12 de novembro de 2026 às 21h30&lt;/p&gt;&lt;p&gt;📌Teatro Miguel Franco&lt;/p&gt;</description>
      <pubDate>Mon, 05 Oct 2026 10:00:00 +0000</pubDate>
      <link>https://www.cm-leiria.pt/evento/concerto-aberta</link>
    </item></channel></rss>`;

	test("title is decoded, quotes straightened, surrogate pairs rejoined", () => {
		const [event] = parseFeed(feed);
		expect(event?.title).toBe('Concerto & Festa "Aberta" d\'Avó 📌');
	});
});

describe("fingerprintUndated", () => {
	test("same title + venue => identical fingerprint", () => {
		const a = fingerprintUndated(
			"Diálogo Aberto sobre Envelhecimento Ativo",
			"CM Leiria",
		);
		const b = fingerprintUndated(
			"Diálogo Aberto sobre Envelhecimento Ativo",
			"CM Leiria",
		);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{40}$/);
	});
	test("differs from the dated fingerprint of the same title + venue", () => {
		const title = "Trail dos Trilhos da Mata";
		const venue = "Sede da Associação Desportiva e Recreativa da Mata";
		const undated = fingerprintUndated(title, venue);
		const dated = fingerprint(title, venue, 1767139200); // some epoch
		expect(undated).not.toBe(dated);
	});
});
