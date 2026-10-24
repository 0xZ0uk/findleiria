/**
 * The week's-pick CLI core against a real libSQL file DB with the shipped
 * migrations applied (same harness as free-featured-ingest.test.ts).
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

const dir = mkdtempSync(join(tmpdir(), "feature-cli-"));
const testDb = drizzle({
	connection: { url: `file:${join(dir, "test.db")}` },
	schema,
});
mock.module("@events-tracker/db", () => ({
	db: testDb,
	schema,
	createDb: () => testDb,
}));
const { clearFeatured, listFeatured, setFeatured } = await import("./feature");

const MIGRATIONS = join(import.meta.dir, "../../../packages/db/src/migrations");
/** 2030-03-17 — an arbitrary future instant. */
const START = 1_900_000_000;
const NOW = 1_800_000_000;

beforeAll(async () => {
	await migrate(testDb, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
	await testDb.delete(schema.events);
	await testDb.insert(schema.events).values([
		{
			title: "Mais tarde",
			slug: "mais-tarde",
			start_at: START + 86_400,
			fingerprint: "fp-b",
		},
		{
			title: "Mais cedo",
			slug: "mais-cedo",
			start_at: START,
			fingerprint: "fp-a",
		},
		{
			title: "Sem destaque",
			slug: "sem-destaque",
			start_at: START + 2 * 86_400,
			fingerprint: "fp-c",
		},
	]);
});

afterAll(() => {
	testDb.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

const featuredAt = async (slug: string) =>
	(
		await testDb
			.select({ f: schema.events.featured_at })
			.from(schema.events)
			.where(eq(schema.events.slug, slug))
	)[0]?.f;

describe("feature CLI core", () => {
	test("setFeatured stamps the event with the given time", async () => {
		const picked = await setFeatured("mais-cedo", NOW);
		expect(picked).toMatchObject({ slug: "mais-cedo", featuredAt: NOW });
		expect(await featuredAt("mais-cedo")).toBe(NOW);
		expect(await featuredAt("mais-tarde")).toBeNull();
	});

	test("an unknown slug is null and writes nothing", async () => {
		expect(await setFeatured("nao-existe", NOW)).toBeNull();
		expect(await clearFeatured("nao-existe")).toBeNull();
		expect(await listFeatured()).toEqual([]);
	});

	test("clearFeatured drops the pick, and is a no-op on an unpicked event", async () => {
		await setFeatured("mais-cedo", NOW);
		expect((await clearFeatured("mais-cedo"))?.featuredAt).toBeNull();
		expect(await featuredAt("mais-cedo")).toBeNull();
		expect((await clearFeatured("sem-destaque"))?.slug).toBe("sem-destaque");
	});

	test("listFeatured returns only picks, soonest event first", async () => {
		await setFeatured("mais-tarde", NOW);
		await setFeatured("mais-cedo", NOW + 1);
		const picks = await listFeatured();
		expect(picks.map((p) => p.slug)).toEqual(["mais-cedo", "mais-tarde"]);
		expect(picks[0]).toMatchObject({
			title: "Mais cedo",
			startAt: START,
			featuredAt: NOW + 1,
		});
	});
});
