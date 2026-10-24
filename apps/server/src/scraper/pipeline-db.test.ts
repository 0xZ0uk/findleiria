/**
 * C7-C10 / C14 write paths against a real libSQL file DB with the shipped
 * migrations: the per-source transaction, the run record's new columns, the
 * runner's state commit, the batch post-passes (purge, venue merge with its
 * geocode copy), and the digest's one-row-per-event query.
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
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { RawEvent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "c7-c10-pipeline-"));
const testDb = drizzle({
	connection: { url: `file:${join(dir, "test.db")}` },
	schema,
});
mock.module("@events-tracker/db", () => ({
	db: testDb,
	schema,
	createDb: () => testDb,
}));
const { ingestSource, recordPostPasses, runPostPasses } = await import(
	"./ingest"
);
const { runSource } = await import("./runner");
const { purgePastEvents } = await import("./purge");
const { buildDigest } = await import("../digest-core");
const { UNKNOWN_CITY } = await import("./venue-city");

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
	title: "Concerto de Primavera",
	slug: "item",
	description: null,
	startAt: START,
	endAt: null,
	dateText: null,
	venueName: "Teatro José Lúcio da Silva",
	city: "Leiria",
	categories: [],
	imageUrl: null,
	url: "https://example.test/item",
	...over,
});

const count = async (
	table: typeof schema.events | typeof schema.venues | typeof schema.scrapeRuns,
) => (await testDb.select().from(table)).length;

let seq = 0;
async function insertEvent(over: Partial<typeof schema.events.$inferInsert>) {
	seq++;
	const [row] = await testDb
		.insert(schema.events)
		.values({
			title: `E${seq}`,
			slug: `e-${seq}`,
			start_at: START,
			fingerprint: `fp-${seq}`,
			created_at: 0,
			updated_at: 0,
			...over,
		})
		.returning({ id: schema.events.id });
	const id = row?.id ?? -1;
	await testDb.insert(schema.eventSources).values({
		event_id: id,
		source: "leiriagenda",
		source_event_id: `item-${seq}`,
		first_seen_at: 0,
		last_seen_at: 0,
	});
	return id;
}

describe("ingestSource: one transaction per source, a richer run record (C8, C10)", () => {
	test("the run row carries discovered, pages, updated; no post-passes ran", async () => {
		const meta = {
			found: 2,
			failures: 0,
			firstError: null,
			discovered: 40,
			pagesFetched: 5,
		};
		await ingestSource(
			[raw({ slug: "a" }), raw({ slug: "b", title: "Outro" })],
			"bol",
			meta,
		);
		const second = await ingestSource(
			[raw({ slug: "a", categories: ["Música"] })],
			"bol",
			meta,
		);
		expect(second.itemsUpdated).toBe(1);
		const runs = await testDb
			.select()
			.from(schema.scrapeRuns)
			.orderBy(schema.scrapeRuns.id);
		expect(runs).toHaveLength(2);
		expect(runs[1]).toMatchObject({
			source: "bol",
			items_found: 2,
			items_discovered: 40,
			pages_fetched: 5,
			items_new: 0,
			items_updated: 1,
			items_pruned: 0,
			items_failed: 0,
			error: null,
			warnings: null,
			postpass_error: null,
		});
	});

	test("a transaction that fails rolls the whole source back", async () => {
		// NaN cannot be stored in the NOT NULL items_found column: the run-row
		// insert, the transaction's last statement, throws.
		await expect(
			ingestSource(
				[raw({ slug: "a" }), raw({ slug: "b", title: "B" })],
				"bol",
				{
					found: Number.NaN,
					failures: 0,
					firstError: null,
				},
			),
		).rejects.toThrow();
		expect(await count(schema.events)).toBe(0);
		expect(await count(schema.venues)).toBe(0);
	});

	test("a raw whose write throws is counted; the rest of the source commits", async () => {
		const res = await ingestSource(
			[
				raw({ slug: "ok" }),
				raw({ slug: "bad", title: null as unknown as string }),
			],
			"bol",
		);
		expect(res.itemsNew).toBe(1);
		expect(res.itemsWriteFailed).toBe(1);
		expect(res.itemsFailed).toBe(1);
		expect(await count(schema.events)).toBe(1);
	});
});

describe("runSource commits a source's state only after its ingest (C7, real DB)", () => {
	test("success: rows written, then committed", async () => {
		const commits: number[] = [];
		const run = await runSource("caldas", async () => ({
			events: [raw({ slug: "c-1" })],
			failures: 0,
			firstError: null,
			discovered: 1,
			commit: () => {
				commits.push(Date.now());
			},
		}));
		expect(run.status).toBe("ok");
		expect(run.stateCommitted).toBe(true);
		expect(commits).toHaveLength(1);
		expect(await count(schema.events)).toBe(1);
	});

	test("a failed write: the good row is kept, the state is NOT committed", async () => {
		const commits: number[] = [];
		const run = await runSource("caldas", async () => ({
			events: [
				raw({ slug: "c-1" }),
				raw({ slug: "c-2", title: null as unknown as string }),
			],
			failures: 0,
			firstError: null,
			discovered: 2,
			commit: () => {
				commits.push(1);
			},
		}));
		expect(run.stateCommitted).toBe(false);
		expect(commits).toEqual([]);
		expect(run.status).toBe("partial");
		expect(await count(schema.events)).toBe(1);
	});

	test("a rolled-back ingest: nothing written, not committed, a run row says why", async () => {
		// The transaction's own run row (error NULL here) is refused, so the
		// transaction throws at its last statement and rolls back; the
		// fallback row, which carries the error, is let through.
		await testDb.run(
			sql`CREATE TRIGGER c7_fail_run BEFORE INSERT ON scrape_runs WHEN NEW.error IS NULL BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
		);
		try {
			const commits: number[] = [];
			const run = await runSource("caldas", async () => ({
				events: [raw({ slug: "c-1" })],
				failures: 0,
				firstError: null,
				commit: () => {
					commits.push(1);
				},
			}));
			expect(run.status).toBe("failed");
			expect(run.error).toContain("ingest failed");
			expect(commits).toEqual([]);
			expect(await count(schema.events)).toBe(0);
			expect(await count(schema.venues)).toBe(0);
			const [row] = await testDb.select().from(schema.scrapeRuns);
			expect(row?.error).toContain("ingest failed");
			expect(row?.error).toContain("disk full");
		} finally {
			await testDb.run(sql`DROP TRIGGER c7_fail_run`);
		}
	});
});

describe("post-passes (C8, C14)", () => {
	test("purge: expired dated rows go with their attributions; live, ongoing and undated stay", async () => {
		const now = START;
		const expired = await insertEvent({ start_at: now - 3 * DAY });
		const endedYesterday = await insertEvent({
			start_at: now - 5 * DAY,
			end_at: now - DAY,
		});
		const future = await insertEvent({ start_at: now + 3600 });
		const ongoing = await insertEvent({
			start_at: now - 5 * DAY,
			end_at: now + DAY,
		});
		const undated = await insertEvent({
			start_at: now - 10 * DAY,
			date_text: "brevemente",
		});
		expect(await purgePastEvents(now)).toBe(2);
		const left = (await testDb.select().from(schema.events)).map((e) => e.id);
		expect(left.sort()).toEqual([future, ongoing, undated].sort());
		const attributed = (await testDb.select().from(schema.eventSources)).map(
			(s) => s.event_id,
		);
		expect(attributed).not.toContain(expired);
		expect(attributed).not.toContain(endedYesterday);
		expect(attributed).toHaveLength(3);
	});

	test("venue merge: variants fuse onto one row that inherits the geocode, address and town", async () => {
		const [canonical, located, unknownTown, otherTown] = await testDb
			.insert(schema.venues)
			.values([
				{ name: "Black Box", slug: "black-box", city: "Leiria" },
				{
					name: "Black Box - Plataforma de Criação Artística de Leiria",
					slug: "black-box-plataforma",
					city: "Leiria",
					lat: 39.74,
					lng: -8.81,
					address: "Rua da Black Box",
				},
				{ name: "BLACK BOX", slug: "black-box-distrito", city: UNKNOWN_CITY },
				{ name: "Black Box", slug: "black-box-pombal", city: "Pombal" },
			])
			.returning({ id: schema.venues.id });
		const atLocated = await insertEvent({ venue_id: located?.id });
		const atUnknown = await insertEvent({ venue_id: unknownTown?.id });
		await insertEvent({ venue_id: otherTown?.id });

		// Two towns now know the name, so the unknown-town row may NOT fold…
		let passes = await runPostPasses();
		expect(passes.errors).toEqual([]);
		expect(passes.venuesMerged).toBe(1);
		let venues = await testDb.select().from(schema.venues);
		expect(venues.map((v) => v.slug).sort()).toEqual([
			"black-box",
			"black-box-distrito",
			"black-box-pombal",
		]);
		const keeper = venues.find((v) => v.id === canonical?.id);
		expect(keeper).toMatchObject({
			lat: 39.74,
			lng: -8.81,
			address: "Rua da Black Box",
			city: "Leiria",
		});
		const [moved] = await testDb
			.select()
			.from(schema.events)
			.where(eq(schema.events.id, atLocated));
		expect(moved?.venue_id).toBe(canonical?.id);

		// …until only one town does: then it folds into Leiria's row.
		await testDb
			.delete(schema.events)
			.where(eq(schema.events.venue_id, otherTown?.id ?? -1));
		await testDb
			.delete(schema.venues)
			.where(eq(schema.venues.id, otherTown?.id ?? -1));
		passes = await runPostPasses();
		expect(passes.venuesMerged).toBe(1);
		venues = await testDb.select().from(schema.venues);
		expect(venues.map((v) => v.slug)).toEqual(["black-box"]);
		const [folded] = await testDb
			.select()
			.from(schema.events)
			.where(eq(schema.events.id, atUnknown));
		expect(folded?.venue_id).toBe(canonical?.id);
	});

	test("recordPostPasses puts the batch's pass failures on every run row of the batch", async () => {
		const a = await ingestSource([raw({ slug: "a" })], "bol");
		const b = await ingestSource(
			[raw({ slug: "b", title: "B" })],
			"leiriagenda",
		);
		const outcome = {
			purged: 0,
			venuesMerged: 0,
			groupsReconciled: 0,
			errors: ["reconcile failed: boom"],
			timingsMs: { purge: 0, venueMerge: 0, reconcile: 0 },
		};
		await recordPostPasses([a.runId ?? -1, b.runId ?? -1], outcome);
		const runs = await testDb.select().from(schema.scrapeRuns);
		expect(runs.map((r) => r.postpass_error)).toEqual([
			"reconcile failed: boom",
			"reconcile failed: boom",
		]);
		// The source's own error stays its own.
		expect(runs.map((r) => r.error)).toEqual([null, null]);
	});
});

describe("digest lists each event once (C9)", () => {
	test("a multi-source event is one line carrying all its sources", async () => {
		const shared = await insertEvent({ title: "Fado no Castelo" });
		await testDb.insert(schema.eventSources).values({
			event_id: shared,
			source: "bol",
			source_event_id: "bol-1",
			first_seen_at: 0,
		});
		await insertEvent({ title: "Jazz na Praça", start_at: START + 3600 });
		const digest = await buildDigest({ since: START - 1, keywords: ["fado"] });
		expect(digest.total).toBe(2);
		expect(digest.events.map((e) => e.title)).toEqual([
			"Fado no Castelo",
			"Jazz na Praça",
		]);
		expect(digest.events[0]?.source).toBe("bol, leiriagenda");
		expect(digest.events[1]?.source).toBe("leiriagenda");
		expect(digest.hits).toBe(1);
	});
});
