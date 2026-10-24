/**
 * events.is_free / events.featured_at through ingest and reconcile, against a
 * real libSQL file DB with the shipped migrations applied (same harness as
 * identity-lifecycle-ingest.test.ts).
 *
 * is_free: a known value beats unknown and is never overwritten, not even by
 * a source that disagrees. featured_at: hand-set, never written by ingest,
 * never lost to a re-ingest or a reconcile merge.
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

import type { RawEvent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "free-featured-"));
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
/** 2030-03-17 — safely in the future, so the past guard and purge stay out. */
const START = 1_900_000_000;

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
	title: "Concerto de Verão",
	slug: "item-1",
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

async function rows() {
	return testDb
		.select({
			id: schema.events.id,
			title: schema.events.title,
			is_free: schema.events.is_free,
			featured_at: schema.events.featured_at,
		})
		.from(schema.events)
		.orderBy(schema.events.id);
}

describe("is_free merge", () => {
	test("is stored as given: true, false, and null when unsaid", async () => {
		await ingest(
			[
				raw({ slug: "a", title: "Livre", isFree: true }),
				raw({ slug: "b", title: "Pago", isFree: false }),
				raw({ slug: "c", title: "Calado" }),
				raw({ slug: "d", title: "Nulo", isFree: null }),
			],
			"ticketline",
		);
		const byTitle = new Map((await rows()).map((r) => [r.title, r.is_free]));
		expect(byTitle.get("Livre")).toBe(true);
		expect(byTitle.get("Pago")).toBe(false);
		expect(byTitle.get("Calado")).toBeNull();
		expect(byTitle.get("Nulo")).toBeNull();
	});

	test("a later non-null fills an unknown value", async () => {
		await ingest([raw({})], "municipal");
		expect((await rows())[0]?.is_free).toBeNull();
		await ingest([raw({ isFree: true })], "municipal");
		expect((await rows())[0]?.is_free).toBe(true);
	});

	test("a later null never overwrites a known value", async () => {
		await ingest([raw({ isFree: true })], "municipal");
		await ingest([raw({ isFree: null })], "municipal");
		await ingest([raw({})], "municipal");
		expect((await rows())[0]?.is_free).toBe(true);
	});

	test("two sources that disagree keep the existing value", async () => {
		await ingest([raw({ isFree: false })], "municipal");
		await ingest([raw({ isFree: true })], "nocartaz");
		expect(await rows()).toHaveLength(1);
		expect((await rows())[0]?.is_free).toBe(false);
	});

	test("a second source's known value fills the first source's unknown", async () => {
		await ingest([raw({})], "municipal");
		await ingest([raw({ isFree: true })], "nocartaz");
		expect(await rows()).toHaveLength(1);
		expect((await rows())[0]?.is_free).toBe(true);
	});
});

describe("featured_at", () => {
	const feature = (id: number, at: number) =>
		testDb
			.update(schema.events)
			.set({ featured_at: at })
			.where(eq(schema.events.id, id));

	test("ingest inserts it null", async () => {
		await ingest([raw({ isFree: true })], "municipal");
		expect((await rows())[0]?.featured_at).toBeNull();
	});

	test("re-ingesting a picked event keeps the pick, whatever else changes", async () => {
		await ingest([raw({})], "municipal");
		const [row] = await rows();
		await feature(row?.id ?? -1, 1_800_000_000);
		await ingest(
			[raw({ isFree: true, endAt: START + 3600, categories: ["Música"] })],
			"municipal",
		);
		const [after] = await rows();
		expect(after?.featured_at).toBe(1_800_000_000);
		expect(after?.is_free).toBe(true);
	});
});

describe("reconcile merge carries what the absorbed row knew", () => {
	test("the keeper inherits a known is_free and a pick from the absorbed row", async () => {
		// Same show 30 min apart from two sources: viralagenda (low trust) is
		// absorbed into municipal's row by the reconcile post-pass.
		await ingest([raw({ slug: "va-1", isFree: true })], "viralagenda");
		const [lone] = await rows();
		await testDb
			.update(schema.events)
			.set({ featured_at: 1_800_000_000 })
			.where(eq(schema.events.id, lone?.id ?? -1));

		await ingest([raw({ slug: "mun-1", startAt: START + 1800 })], "municipal");
		const merged = await rows();
		expect(merged).toHaveLength(1);
		expect(merged[0]?.is_free).toBe(true);
		expect(merged[0]?.featured_at).toBe(1_800_000_000);
	});
});
