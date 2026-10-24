/**
 * C4-C6 against a real libSQL file DB with the shipped migrations applied:
 * recurrences stay apart (C4), re-scrapes refresh their own row and full
 * listings prune what they stopped listing (C5), and ingest + reconcile
 * converge instead of undoing each other every run (C6).
 *
 * Same harness as venue-towns-ingest.test.ts: `@events-tracker/db` is mocked
 * with a temp-file DB before the code under test is imported, so no env DB is
 * ever touched.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as schema from "@events-tracker/db/schema/index";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { ScrapeMeta } from "./ingest";
import type { RawEvent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "c456-identity-"));
const testDb = drizzle({
	connection: { url: `file:${join(dir, "test.db")}` },
	schema,
});
mock.module("@events-tracker/db", () => ({
	db: testDb,
	schema,
	createDb: () => testDb,
}));
const { ingest } = await import("./ingest");
const { reconcileIdentities } = await import("./reconcile");
const { deleteEvents } = await import("./event-delete");
const { UNLISTED_PRUNE_SECONDS } = await import("./purge");

const MIGRATIONS = join(
	import.meta.dir,
	"../../../../packages/db/src/migrations",
);
/** 2030-03-17 — safely in the future, so the past guard and purge stay out. */
const START = 1_900_000_000;
const DAY = 86_400;

beforeAll(async () => {
	await migrate(testDb, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
	await testDb.delete(schema.eventAliases);
	await testDb.delete(schema.eventSources);
	await testDb.delete(schema.events);
	await testDb.delete(schema.venues);
	await testDb.delete(schema.scrapeRuns);
});

afterAll(() => {
	testDb.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

const raw = (over: Partial<RawEvent>): RawEvent => ({
	title: "Tasquinhas da Bidoeira",
	slug: "rl-tasquinhas",
	description: null,
	startAt: START,
	endAt: null,
	dateText: null,
	venueName: "Largo da Feira",
	city: "Leiria",
	categories: [],
	imageUrl: null,
	url: "https://example.test/item",
	...over,
});

/** A regiaoleiria-style day page: one item id, one page per festival day. */
const dayPage = (n: number, slug = "rl-tasquinhas"): RawEvent => {
	const at = START + n * DAY;
	return raw({ slug, startAt: at, endAt: at, url: `https://rl.test/${slug}` });
};

async function allEvents() {
	return testDb
		.select({
			id: schema.events.id,
			slug: schema.events.slug,
			title: schema.events.title,
			start_at: schema.events.start_at,
			end_at: schema.events.end_at,
			fingerprint: schema.events.fingerprint,
			date_text: schema.events.date_text,
		})
		.from(schema.events)
		.orderBy(schema.events.id);
}

async function aliasesOf(eventId: number) {
	const rows = await testDb
		.select()
		.from(schema.eventAliases)
		.where(eq(schema.eventAliases.event_id, eventId));
	return rows.map((r) => `${r.source}:${r.source_event_id}`).sort();
}

describe("C4 — recurrences of one source item stay separate rows", () => {
	test("a monthly feira (1 slug, 3 dates a month apart) is three cards", async () => {
		const feira = [0, 30, 60].map((d) =>
			raw({
				title: "Feira Mensal",
				slug: "feira-mensal",
				startAt: START + d * DAY,
			}),
		);
		const first = await ingest(feira, "municipal");
		expect(first.itemsNew).toBe(3);
		expect(first.error).toBeNull();
		const events = await allEvents();
		expect(events.length).toBe(3);
		// No row stretched across the months.
		expect(events.map((e) => e.end_at)).toEqual([null, null, null]);
		expect(events.map((e) => e.start_at)).toEqual(
			[0, 30, 60].map((d) => START + d * DAY),
		);

		const second = await ingest(feira, "municipal");
		expect(second.itemsNew).toBe(0);
		expect(await allEvents()).toEqual(events);
	});

	test("consecutive day pages of one item are still one card spanning the run", async () => {
		const result = await ingest(
			[1, 2, 3].map((n) => dayPage(n)),
			"regiaoleiria",
		);
		expect(result.error).toBeNull();
		const events = await allEvents();
		expect(events.length).toBe(1);
		expect(events[0]?.start_at).toBe(START + DAY);
		expect(events[0]?.end_at).toBe(START + 3 * DAY);
	});
});

describe("C6 — ingest and reconcile converge on re-emitted day pages", () => {
	test("pages arriving last-day-first: reconcile folds them once, later runs add nothing", async () => {
		const pages = [3, 2, 1].map((n) => dayPage(n));
		const first = await ingest(pages, "regiaoleiria");
		expect(first.error).toBeNull();
		const events = await allEvents();
		expect(events.length).toBe(1);
		const keeper = events[0];
		expect(keeper?.start_at).toBe(START + DAY);
		expect(keeper?.end_at).toBe(START + 3 * DAY);
		// The folded pages' attributions clashed with the keeper's: kept as an
		// alias instead of being lost.
		expect(await aliasesOf(keeper?.id ?? -1)).toEqual([
			"regiaoleiria:rl-tasquinhas",
		]);

		for (let run = 0; run < 2; run++) {
			const again = await ingest(pages, "regiaoleiria");
			expect(again.itemsNew).toBe(0);
			expect(again.itemsUpdated).toBe(0);
			expect(await allEvents()).toEqual(events);
		}
	});

	test("pages in day order fold at ingest; the second run reports new: 0, same slug", async () => {
		const pages = [1, 2, 3].map((n) => dayPage(n));
		const first = await ingest(pages, "regiaoleiria");
		expect(first.itemsNew).toBe(1);
		const events = await allEvents();
		expect(events.length).toBe(1);

		const second = await ingest(pages, "regiaoleiria");
		expect(second.itemsNew).toBe(0);
		expect(second.itemsUpdated).toBe(0);
		expect(await allEvents()).toEqual(events);
	});

	test("a second item of the same source folded into the keeper resolves to it via its alias", async () => {
		// Two items of one source for the same show, 30 min apart: reconcile
		// keeps one row, and the other item's attribution cannot move onto it
		// (one per source per event). It used to be deleted, so every run the
		// item came back as a new row and was absorbed again.
		const batch = [
			raw({ slug: "rl-a", startAt: START }),
			raw({ slug: "rl-b", startAt: START + 1800 }),
		];
		const first = await ingest(batch, "regiaoleiria");
		expect(first.itemsNew).toBe(2);
		const events = await allEvents();
		expect(events.length).toBe(1);
		const keeper = events[0];
		expect(await aliasesOf(keeper?.id ?? -1)).toEqual(["regiaoleiria:rl-b"]);

		for (let run = 0; run < 2; run++) {
			const again = await ingest(batch, "regiaoleiria");
			expect(again.itemsNew).toBe(0);
			expect(await allEvents()).toEqual(events);
		}
	});

	test("aliases of deleted events are swept by the next reconcile", async () => {
		await ingest(
			[3, 2, 1].map((n) => dayPage(n)),
			"regiaoleiria",
		);
		const [keeper] = await allEvents();
		await deleteEvents([keeper?.id ?? -1]);
		await reconcileIdentities();
		expect(await testDb.select().from(schema.eventAliases)).toEqual([]);
	});
});

describe("C5 — the best source refreshes its own occurrence", () => {
	test("a re-timed and retitled item updates its row in place; the slug never changes", async () => {
		await ingest(
			[raw({ title: "Concerto de Primavera", slug: "pv", startAt: START })],
			"municipal",
		);
		const [before] = await allEvents();

		const res = await ingest(
			[
				raw({
					title: "Concerto de Primavera (novo horário)",
					slug: "pv",
					startAt: START + 1800,
					endAt: START + 7200,
				}),
			],
			"municipal",
		);
		expect(res.itemsNew).toBe(0);
		expect(res.itemsUpdated).toBe(1);
		const after = await allEvents();
		expect(after.length).toBe(1);
		expect(after[0]?.id).toBe(before?.id ?? -1);
		expect(after[0]?.slug).toBe(before?.slug ?? "");
		expect(after[0]?.title).toBe("Concerto de Primavera (novo horário)");
		expect(after[0]?.start_at).toBe(START + 1800);
		expect(after[0]?.end_at).toBe(START + 7200);
		expect(after[0]?.fingerprint).not.toBe(before?.fingerprint ?? "");

		// Converged: the next identical scrape is a no-op.
		const again = await ingest(
			[
				raw({
					title: "Concerto de Primavera (novo horário)",
					slug: "pv",
					startAt: START + 1800,
					endAt: START + 7200,
				}),
			],
			"municipal",
		);
		expect(again.itemsUpdated).toBe(0);
		expect(await allEvents()).toEqual(after);
	});

	test("a lower-trust source never re-times the best source's row", async () => {
		await ingest([raw({ slug: "m-1", startAt: START })], "municipal");
		const [before] = await allEvents();
		// Viral Agenda's DST-shifted twin: reconcile absorbs it into the
		// municipal row; its later re-scrapes find that row and only backfill.
		for (let run = 0; run < 2; run++) {
			await ingest(
				[raw({ slug: "va-1", startAt: START - 3600, endAt: START + 3600 })],
				"viralagenda",
			);
		}
		const after = await allEvents();
		expect(after.length).toBe(1);
		expect(after[0]?.id).toBe(before?.id ?? -1);
		expect(after[0]?.start_at).toBe(START);
		expect(after[0]?.slug).toBe(before?.slug ?? "");
	});

	test("an undated ghost is cleaned when the dated row already exists", async () => {
		await ingest([raw({ slug: "d-1" })], "leiriagenda");
		// Another source lists the same event without a parseable date.
		await ingest(
			[raw({ slug: "u-1", startAt: null, dateText: "brevemente" })],
			"cmleiriarss",
		);
		expect((await allEvents()).length).toBe(2);

		await ingest([raw({ slug: "d-1" })], "leiriagenda");
		const events = await allEvents();
		expect(events.length).toBe(1);
		expect(events[0]?.date_text).toBeNull();
	});

	test("every ingest that lists an item refreshes its last_seen_at", async () => {
		await ingest([raw({ slug: "s-1" })], "leiriagenda");
		await testDb.update(schema.eventSources).set({ last_seen_at: 1 });
		await ingest([raw({ slug: "s-1" })], "leiriagenda");
		const [attr] = await testDb.select().from(schema.eventSources);
		expect(attr?.last_seen_at ?? 0).toBeGreaterThan(1);
	});
});

describe("C5 — pruning rows a full listing stopped publishing", () => {
	const full: ScrapeMeta = {
		found: 1,
		failures: 0,
		firstError: null,
		fullListing: true,
	};
	const now = () => Math.floor(Date.now() / 1000);
	const titled = (slug: string, over: Partial<RawEvent> = {}) =>
		raw({
			title: `Evento ${slug}`,
			slug,
			url: `https://x.test/${slug}`,
			...over,
		});

	/** Pretend every attribution was last listed `days` days ago. */
	async function ageAll(days: number) {
		await testDb
			.update(schema.eventSources)
			.set({ last_seen_at: now() - days * DAY });
	}

	async function titles() {
		return (await allEvents()).map((e) => e.title).sort();
	}

	test("an item unlisted for 3+ days goes; the listed one stays", async () => {
		await ingest([titled("a"), titled("b")], "leiriagenda");
		await ageAll(UNLISTED_PRUNE_SECONDS / DAY + 1);
		const res = await ingest([titled("a")], "leiriagenda", full);
		expect(res.itemsPruned).toBe(1);
		expect(res.error).toBeNull();
		expect(await titles()).toEqual(["Evento a"]);
	});

	test("undated rows follow the same unseen-for-N-days rule", async () => {
		await ingest(
			[titled("a"), titled("u", { startAt: null, dateText: "em breve" })],
			"leiriagenda",
		);
		await ageAll(4);
		const res = await ingest([titled("a")], "leiriagenda", full);
		expect(res.itemsPruned).toBe(1);
		expect(await titles()).toEqual(["Evento a"]);
	});

	test("not before the threshold", async () => {
		await ingest([titled("a"), titled("b")], "leiriagenda");
		await ageAll(2);
		const res = await ingest([titled("a")], "leiriagenda", full);
		expect(res.itemsPruned).toBe(0);
		expect(await titles()).toEqual(["Evento a", "Evento b"]);
	});

	test("never without a complete full-listing run", async () => {
		await ingest([titled("a"), titled("b")], "leiriagenda");
		await ageAll(5);
		// Default meta (manual ingest, incremental sources): no prune.
		await ingest([titled("a")], "leiriagenda");
		// A run with a failure: no prune.
		await ingest([titled("a")], "leiriagenda", { ...full, failures: 1 });
		// An empty listing: no prune.
		await ingest([], "leiriagenda", { ...full, found: 0 });
		expect(await titles()).toEqual(["Evento a", "Evento b"]);
	});

	test("never a row another source still vouches for", async () => {
		await ingest([titled("a"), titled("b")], "leiriagenda");
		await ingest([titled("b", { slug: "va-b" })], "viralagenda");
		await ageAll(5);
		const res = await ingest([titled("a")], "leiriagenda", full);
		expect(res.itemsPruned).toBe(0);
		expect(await titles()).toEqual(["Evento a", "Evento b"]);
	});

	test("never an ongoing event (started, not yet ended)", async () => {
		const t = now();
		await ingest(
			[titled("a"), titled("live", { startAt: t - 3600, endAt: t + DAY })],
			"leiriagenda",
		);
		await ageAll(5);
		const res = await ingest([titled("a")], "leiriagenda", full);
		expect(res.itemsPruned).toBe(0);
		expect(await titles()).toEqual(["Evento a", "Evento live"]);
	});

	test("the circuit breaker refuses a prune that would empty the source", async () => {
		const items = ["a", "b", "c", "d", "e"].map((s) => titled(s));
		await ingest(items, "leiriagenda");
		await ageAll(5);
		const res = await ingest([titled("a")], "leiriagenda", full);
		expect(res.itemsPruned).toBe(0);
		// The breaker working is a warning, not a failed run (C10).
		expect(res.error).toBeNull();
		expect(res.warnings).toContain("prune refused");
		expect((await titles()).length).toBe(5);
	});
});
