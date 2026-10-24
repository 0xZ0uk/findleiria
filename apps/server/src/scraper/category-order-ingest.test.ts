/**
 * C13 against a real libSQL file DB with the shipped migrations applied: the
 * category order is the display order on every write path, and re-ingesting an
 * event is a no-op, not one spurious update per event.
 *
 * Env-independent, same harness as venue-towns-ingest.test.ts: the db module
 * is mocked with a temp-file DB before the code under test is imported.
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
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { RawEvent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "c13-category-order-"));
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

const MIGRATIONS = join(
	import.meta.dir,
	"../../../../packages/db/src/migrations",
);
/** 2030-03-17: safely in the future, so the past guard and purge stay out. */
const START = 1_900_000_000;

beforeAll(async () => {
	await migrate(testDb, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
	await testDb.delete(schema.eventSources);
	await testDb.delete(schema.events);
	await testDb.delete(schema.venues);
	await testDb.delete(schema.scrapeRuns);
});

afterAll(() => {
	testDb.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

const DISPLAY_DEFAULT = ["Teatro", "Música"];

const raw = (over: Partial<RawEvent>): RawEvent => ({
	title: "Concerto de Natal",
	slug: "item",
	description: null,
	startAt: START,
	endAt: null,
	dateText: null,
	venueName: "Biblioteca Municipal",
	city: "Leiria",
	categories: DISPLAY_DEFAULT,
	imageUrl: null,
	url: "https://example.test/item",
	...over,
});

const storedCategories = async (): Promise<string[]> => {
	const rows = await testDb.select().from(schema.events);
	expect(rows).toHaveLength(1);
	return (rows[0]?.categories ?? []) as string[];
};

// Taxonomy order puts Música before Concertos; alphabetical puts Concertos
// first, so these labels tell the two orders apart.
const DISPLAY = ["Música", "Concertos", "Teatro"];
const REVERSED = ["Teatro", "Concertos", "Música"];

describe("category order is stable across write paths", () => {
	test("insert stores the display order, not the source's order", async () => {
		await ingest([raw({ categories: REVERSED })], "municipal");
		expect(await storedCategories()).toEqual(DISPLAY);
	});

	test("re-ingesting the same event updates nothing", async () => {
		const batch = [raw({ categories: REVERSED })];
		const first = await ingest(batch, "municipal");
		expect(first.itemsNew).toBe(1);
		const before = (await testDb.select().from(schema.events))[0];

		const second = await ingest(batch, "municipal");
		expect(second.itemsNew).toBe(0);
		expect(second.itemsUpdated).toBe(0);
		const after = (await testDb.select().from(schema.events))[0];
		expect(after?.categories).toEqual(DISPLAY);
		expect(after?.updated_at).toEqual(before?.updated_at);
	});

	test("a second source listing the same labels in another order is a no-op", async () => {
		await ingest([raw({ categories: DISPLAY })], "municipal");
		const second = await ingest(
			[raw({ categories: REVERSED, url: "https://va.test/1", slug: "va-1" })],
			"viralagenda",
		);
		expect(second.itemsNew).toBe(0);
		expect(second.itemsUpdated).toBe(0);
		expect(await storedCategories()).toEqual(DISPLAY);
	});

	test("a new category from another source is merged in display order", async () => {
		await ingest([raw({ categories: ["Teatro"] })], "municipal");
		const second = await ingest(
			[
				raw({
					categories: ["Música", "Concertos"],
					url: "https://va.test/1",
					slug: "va-1",
				}),
			],
			"viralagenda",
		);
		expect(second.itemsUpdated).toBe(1);
		expect(await storedCategories()).toEqual(DISPLAY);
	});

	test("a legacy alphabetical row is not rewritten just to reorder it", async () => {
		await ingest([raw({ categories: ["Teatro"] })], "municipal");
		// Simulate a row stored by the old plain .sort() update path.
		await testDb.update(schema.events).set({
			categories: ["Concertos", "Música", "Teatro"],
		});
		const res = await ingest(
			[raw({ categories: ["Música", "Teatro", "Concertos"] })],
			"municipal",
		);
		expect(res.itemsUpdated).toBe(0);
	});
});
