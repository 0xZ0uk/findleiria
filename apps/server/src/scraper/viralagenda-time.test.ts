import { describe, expect, test } from "bun:test";
import { must } from "../test-helpers";
import { fingerprint } from "./fingerprint";
import type { DetailEvent, ListingCard } from "./viralagenda";
import { toRawEvent } from "./viralagenda";

/**
 * SLICE_6 dedupe regression: Viral Agenda's detail JSON-LD startDate is one
 * hour early during DST (card 21:30+01:00 vs JSON-LD 20:30+01:00 — verified
 * live 2026-09-02 on event 1834760). The card is the site's UI time and
 * agrees with leiriagenda/eventbrite, so card time must win; otherwise the
 * event hashes to a different fingerprint than its leiriagenda twin and
 * ingests as a duplicate row.
 */

const card: ListingCard = {
	id: "1834760",
	url: "https://www.viralagenda.com/pt/events/1834760/carolina-de-deus-trio",
	title: "Carolina de Deus",
	city: "Leiria",
	cities: ["Leiria"],
	venue: "Teatro José Lúcio da Silva",
	categories: ["Música"],
	// What VA's listing UI shows: 21:30 WEST.
	dateStart: "2026-09-11T21:30:00+01:00",
	dateEnd: "2026-09-11T21:30:00+01:00",
	hasTime: true,
	imageUrl: null,
};

// What VA's JSON-LD emits: 20:30 with a stale +01:00 label (bug).
const buggyDetail: DetailEvent = {
	name: "Carolina de Deus",
	startDate: "2026-09-11T20:30:00+01:00",
	endDate: "2026-09-11",
	image: null,
	description: null,
	venue: "Teatro José Lúcio da Silva",
	city: "Leiria",
};

describe("viralagenda card-first time policy (DST drift)", () => {
	test("card time wins over the DST-shifted JSON-LD time", () => {
		const raw = must(toRawEvent(card, buggyDetail));
		// 2026-09-11 21:30 WEST.
		expect(raw.startAt).toBe(1789158600);
	});

	test("the corrected time hashes to the same fingerprint as leiriagenda's row", () => {
		const raw = must(toRawEvent(card, buggyDetail));
		// leiriagenda stored the same show at 21:30 WEST.
		expect(
			fingerprint(raw.title, "teatro-jose-lucio-da-silva", must(raw.startAt)),
		).toBe(
			fingerprint("Carolina de Deus", "teatro-jose-lucio-da-silva", 1789158600),
		);
	});

	test("detail time still used when the card has a placeholder (00:59/N-D)", () => {
		const noTimeCard: ListingCard = {
			...card,
			dateStart: "2026-09-11T00:59:00+01:00",
			hasTime: false,
		};
		const raw = must(toRawEvent(noTimeCard, buggyDetail));
		// 20:30+01:00 parsed as an absolute instant → 19:30 UTC.
		expect(raw.startAt).toBe(1789155000);
	});

	test("no card time + no detail → date-only at midnight Lisbon", () => {
		const raw = must(
			toRawEvent(
				{ ...card, dateStart: "2026-09-11T00:59:00+01:00", hasTime: false },
				null,
			),
		);
		expect(raw.startAt).toBe(1789081200); // 2026-09-11 00:00 WEST
	});
});
