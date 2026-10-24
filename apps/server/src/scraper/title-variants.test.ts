import { describe, expect, test } from "bun:test";

import { toEpochInLisbon } from "./fingerprint";
import {
	planComponents,
	planMerge,
	spanKeeper,
	titleCoreTokens,
} from "./identity";

const at = toEpochInLisbon;

type VariantRow = {
	id: number;
	title: string;
	venue: string | null;
	city: string | null;
	start_at: number;
	end_at?: number | null;
	sources: string[];
	itemKey?: string | null;
};

const endOfDay = (y: number, m: number, d: number): number =>
	at(y, m, d, 23, 59);

describe("RULE 4 — same-day wording variant next to a span row", () => {
	// Real rows 603 (festasearraiais span) and 865-867 (regiaoleiria day
	// pages) from local.db: the span starts the same Lisbon day as the first
	// day page, so pass 1 (grouped by title+day) never saw them together and
	// the site shipped one span card plus three per-day cards.
	const span: VariantRow = {
		id: 603,
		title: "Tasquinhas da Bidoeira 2026 - Bidoeira de Cima",
		venue: "Bidoeira de Cima, Bidoeira de Cima",
		city: "Bidoeira de Cima",
		start_at: at(2026, 10, 1, 23, 0),
		end_at: at(2026, 10, 4, 22, 59),
		sources: ["festasearraiais"],
	};
	const day: VariantRow = {
		id: 865,
		title: "Tasquinhas da Bidoeira",
		venue: "Bidoeira de Cima",
		city: "Bidoeira de Cima",
		start_at: at(2026, 10, 1, 23, 0),
		end_at: at(2026, 10, 1, 23, 0),
		sources: ["regiaoleiria"],
		itemKey: "regiaoleiria:rl-tasquinhas-da-bidoeira-4",
	};

	test("the same-day pair lands in one component", () => {
		const components = planComponents([span, day]);
		expect(components.length).toBe(1);
		expect(components[0]?.map((r) => r.id).sort()).toEqual([603, 865]);
	});

	test("the span keeps the single card", () => {
		const plan = planMerge([span, day]);
		expect(plan.keepers.map((k) => k.id)).toEqual([603]);
		expect(plan.absorbed.get(865)).toBe(603);
	});
});

describe("day pages of ONE source item", () => {
	// regiaoleiria publishes one page per festival day under one item id.
	const pages: VariantRow[] = [1, 2, 3].map((n) => ({
		id: 864 + n,
		title: "Tasquinhas da Bidoeira",
		venue: "Bidoeira de Cima",
		city: "Bidoeira de Cima",
		start_at: at(2026, 10, n, 23, 0),
		end_at: at(2026, 10, n, 23, 0),
		sources: ["regiaoleiria"],
		itemKey: "regiaoleiria:rl-tasquinhas-da-bidoeira-4",
	}));

	test("they are one component even on different days", () => {
		const components = planComponents(pages);
		expect(components.length).toBe(1);
		expect(components[0]?.length).toBe(3);
	});

	test("the earliest page keeps the card and the run widens its end", () => {
		const plan = planMerge(pages);
		expect(plan.keepers.map((k) => k.id)).toEqual([865]);
		expect(plan.absorbed.get(866)).toBe(865);
		expect(plan.absorbed.get(867)).toBe(865);
		expect(plan.endByKeeper?.get(865)).toBe(at(2026, 10, 3, 23, 0));
	});

	test("a component mixing two source items is left to the normal rules", () => {
		const mixed = [
			...pages,
			{
				id: 603,
				title: "Tasquinhas da Bidoeira 2026 - Bidoeira de Cima",
				venue: "Bidoeira de Cima, Bidoeira de Cima",
				city: "Bidoeira de Cima",
				start_at: at(2026, 10, 1, 23, 0),
				end_at: at(2026, 10, 4, 22, 59),
				sources: ["festasearraiais"],
			} satisfies VariantRow,
		];
		const plan = planMerge(mixed);
		expect(plan.keepers.map((k) => k.id)).toEqual([603]);
		expect(plan.absorbed.size).toBe(3);
	});
});

describe("titleCoreTokens", () => {
	test("keeps what names the event, drops wording and edition noise", () => {
		expect(titleCoreTokens("Festas de São Silvestre")).toEqual([
			"sao",
			"silvestre",
		]);
		expect(
			titleCoreTokens("Festa em honra de São Silvestre 2026 - Mato Velho"),
		).toEqual(["sao", "silvestre", "mato", "velho"]);
	});

	test("a title made only of noise has no core", () => {
		expect(titleCoreTokens("Festa 2026")).toEqual([]);
	});
});

describe("RULE 4 — title variants of one occurrence", () => {
	test("São Silvestre: viralagenda twin fuses with the festasearraiais row", () => {
		// Real rows 408 / 549 from local.db (the pair reported on the site).
		const a: VariantRow = {
			id: 408,
			title: "Festas de São Silvestre",
			venue: "São Silvestre - Mato Velho Porto de Mós",
			city: "Porto de Mós",
			start_at: at(2026, 9, 12),
			end_at: endOfDay(2026, 9, 15),
			sources: ["viralagenda"],
		};
		const b: VariantRow = {
			id: 549,
			title: "Festa em honra de São Silvestre 2026 - Mato Velho",
			venue: "Mato Velho, Serro Ventoso",
			city: "Serro Ventoso",
			start_at: at(2026, 9, 12),
			end_at: endOfDay(2026, 9, 15),
			sources: ["festasearraiais"],
		};
		const components = planComponents([a, b]);
		expect(components).toHaveLength(1);
		const plan = planMerge(components[0] ?? []);
		// festasearraiais is now ranked (C2) and outranks viralagenda, so the
		// festa's own row is the canonical one and the viralagenda twin folds in.
		expect(plan.keepers.map((k) => k.id)).toEqual([549]);
		expect(plan.absorbed.get(408)).toBe(549);
	});

	test("per-day rows fuse into the multi-day span of the same festa", () => {
		// Festa da Ordem: festasearraiais publishes the span 18-20/09, the
		// regiaoleiria agenda one row per day.
		const span: VariantRow = {
			id: 635,
			title: "Festa da Ordem 2026 - Marinha Grande",
			venue: "Marinha Grande",
			city: "Marinha Grande",
			start_at: at(2026, 9, 18),
			end_at: endOfDay(2026, 9, 20),
			sources: ["festasearraiais"],
		};
		const days: VariantRow[] = [18, 19, 20].map((d, i) => ({
			id: 825 + i,
			title: "Festa da Ordem",
			venue: "Marinha Grande",
			city: "Marinha Grande",
			start_at: at(2026, 9, d),
			end_at: null,
			sources: ["regiaoleiria"],
		}));
		const components = planComponents([span, ...days]);
		expect(components).toHaveLength(1);
		const plan = planMerge(components[0] ?? []);
		expect(plan.keepers.map((k) => k.id)).toEqual([635]);
		expect([...plan.absorbed.keys()].sort()).toEqual([825, 826, 827]);
	});

	test("a sub-event keeps its own card ('Neon Run - Festival Viver São Bento')", () => {
		const festival: VariantRow = {
			id: 700,
			title: "Festival Viver São Bento 2026",
			venue: "São Bento (Porto de Mós)",
			city: "Porto de Mós",
			start_at: at(2026, 9, 18, 15),
			end_at: endOfDay(2026, 9, 20),
			sources: ["viralagenda"],
		};
		const run: VariantRow = {
			id: 701,
			title: "Neon Run - Festival Viver São Bento 2026",
			venue: "São Bento (Porto de Mós)",
			city: "Porto de Mós",
			start_at: at(2026, 9, 18, 15),
			end_at: at(2026, 9, 18, 23),
			sources: ["viralagenda"],
		};
		expect(planComponents([festival, run])).toHaveLength(2);
	});

	test("an unexplained subtitle keeps its own card", () => {
		const short: VariantRow = {
			id: 710,
			title: "Bertie",
			venue: "Museu de Leiria",
			city: "Leiria",
			start_at: at(2026, 10, 3, 21),
			end_at: null,
			sources: ["viralagenda"],
		};
		const long: VariantRow = {
			id: 711,
			title: "Bertie - Uma performance VR em multiplayer",
			venue: "Museu de Leiria",
			city: "Leiria",
			start_at: at(2026, 10, 3, 21),
			end_at: null,
			sources: ["viralagenda"],
		};
		expect(planComponents([short, long])).toHaveLength(2);
	});

	test("same title on adjacent days stays two occurrences", () => {
		const day1: VariantRow = {
			id: 720,
			title: "Semana Europeia da Mobilidade",
			venue: "Leiria",
			city: "Leiria",
			start_at: at(2026, 9, 18, 10),
			end_at: null,
			sources: ["municipal"],
		};
		const day2: VariantRow = {
			id: 721,
			title: "Semana Europeia da Mobilidade",
			venue: "Leiria",
			city: "Leiria",
			start_at: at(2026, 9, 19, 10),
			end_at: null,
			sources: ["municipal"],
		};
		expect(planComponents([day1, day2])).toHaveLength(2);
	});

	test("unrelated titles at one venue stay separate", () => {
		const a: VariantRow = {
			id: 730,
			title: "Feira do Livro",
			venue: "Museu de Leiria",
			city: "Leiria",
			start_at: at(2026, 10, 3, 15),
			end_at: null,
			sources: ["municipal"],
		};
		const b: VariantRow = {
			id: 731,
			title: "Concerto de Natal",
			venue: "Museu de Leiria",
			city: "Leiria",
			start_at: at(2026, 10, 3, 21),
			end_at: null,
			sources: ["viralagenda"],
		};
		expect(planComponents([a, b])).toHaveLength(2);
	});
});

describe("spanKeeper", () => {
	test("needs a multi-day row that covers every other start", () => {
		const span: VariantRow = {
			id: 1,
			title: "Festa X",
			venue: "V",
			city: "C",
			start_at: at(2026, 9, 18),
			end_at: endOfDay(2026, 9, 20),
			sources: ["municipal"],
		};
		const outside: VariantRow = {
			id: 2,
			title: "Festa Y",
			venue: "V",
			city: "C",
			start_at: at(2026, 9, 25),
			end_at: null,
			sources: ["viralagenda"],
		};
		expect(spanKeeper([span, outside])).toBeUndefined();
		expect(spanKeeper([span])?.id).toBe(1);
	});

	test("highest trust wins when two sources publish a span", () => {
		const trusted: VariantRow = {
			id: 3,
			title: "Festa X",
			venue: "V",
			city: "C",
			start_at: at(2026, 9, 18),
			end_at: endOfDay(2026, 9, 20),
			sources: ["leiriagenda"],
		};
		const platform: VariantRow = {
			id: 4,
			title: "Festa X 2026 - C",
			venue: "V",
			city: "C",
			start_at: at(2026, 9, 18),
			end_at: endOfDay(2026, 9, 20),
			sources: ["viralagenda"],
		};
		expect(spanKeeper([platform, trusted])?.id).toBe(3);
	});

	test("single-day rows never become a span keeper", () => {
		const a: VariantRow = {
			id: 5,
			title: "A",
			venue: "V",
			city: "C",
			start_at: at(2026, 9, 18),
			end_at: null,
			sources: ["municipal"],
		};
		expect(spanKeeper([a])).toBeUndefined();
	});
});
