import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createD1ReadDb, schema } from "@events-tracker/db/client";
import { mirrorToD1 } from "@events-tracker/db/d1-mirror";
import { FAKE_D1, fakeD1 } from "@events-tracker/db/fake-d1";

import { eventBySlug, eventsBySlugs, listEvents } from "./queries/events";
import { buildSnapshot } from "./snapshot";
import {
	createTestDb,
	DAY,
	event,
	insertEvents,
	NOW,
	NOW_MS,
	type TestDb,
} from "./test-db";

/**
 * The production build's path: `buildSnapshot` over the D1 REST API (drizzle
 * sqlite-proxy -> `/raw`) must produce exactly what it produces over the same
 * data in a libSQL file. The data is seeded in a migrated libSQL file, mirrored
 * into a fake D1 REST server with the real publish code (`mirrorToD1`), and
 * read back through `createD1ReadDb`.
 */

let testDb: TestDb;
let fake: ReturnType<typeof fakeD1>;
let d1Db: ReturnType<typeof createD1ReadDb>;

beforeAll(async () => {
	testDb = await createTestDb("findleiria-snapshot-d1-");
	const { db } = testDb;

	await db.insert(schema.venues).values([
		{
			id: 1,
			name: "Teatro José Lúcio da Silva",
			slug: "teatro-jose-lucio-da-silva",
			city: "Leiria",
			lat: 39.7467,
			lng: -8.8039,
			scope: "venue",
		},
		{
			id: 2,
			name: 'Sala d\'Ana; "quoted" -- not a comment',
			slug: "sala-ana",
			city: "Marinha Grande",
			lat: null,
			lng: null,
			scope: "concelho",
		},
	]);
	await insertEvents(db, [
		// Past: outside the agenda window, still a page.
		event(1, "ja-passou", NOW - 30 * DAY),
		event(2, "ontem", NOW - DAY),
		// Two sessions the same day at the same venue: merged in the agenda.
		event(3, "sessao-1", NOW + 2 * DAY, { title: "Concerto ação 🎉" }),
		event(4, "sessao-2", NOW + 2 * DAY + 3 * 3600, {
			title: "Concerto ação 🎉",
		}),
		event(5, "futuro", NOW + 40 * DAY, {
			venue_id: 2,
			description: "Linha 1;\nLinha 2 'x' -- end ?",
			end_at: NOW + 40 * DAY + 7200,
			categories: ["Música", "Teatro"],
		}),
		// Beyond the window.
		event(6, "longe", NOW + 400 * DAY),
		// A slug that looks like a number: a bound string must stay a string.
		event(7, "2026", NOW + 5 * DAY, { venue_id: null, description: null }),
		// Undated announcement.
		event(8, "todo-o-mes", NOW + 3 * DAY, { date_text: "todo o mês" }),
	]);
	await db.insert(schema.scrapeRuns).values({
		id: 1,
		source: "all",
		started_at: NOW - 3600,
		finished_at: NOW - 3500,
		items_found: 8,
		items_new: 2,
	});

	// Mirror the file into the fake D1 exactly as `db:publish` does.
	const local = new Database(testDb.path, {
		readonly: true,
		safeIntegers: true,
	});
	fake = fakeD1();
	try {
		await mirrorToD1(local, fake.d1, { log: () => {} });
	} finally {
		local.close();
	}
	d1Db = createD1ReadDb({ ...FAKE_D1, baseUrl: fake.baseUrl });
});

afterAll(() => {
	fake.stop();
	testDb.cleanup();
});

describe("buildSnapshot over the D1 REST API", () => {
	test("is byte-identical to the libSQL snapshot of the same data", async () => {
		const viaLibsql = await buildSnapshot(testDb.db, NOW_MS);
		const viaD1 = await buildSnapshot(d1Db, NOW_MS);

		// Not vacuous: the fixture produced a window, an undated row and files.
		expect(viaLibsql.agenda.events.length).toBeGreaterThan(2);
		expect(viaLibsql.agenda.undated).toHaveLength(1);
		expect(viaLibsql.events).toHaveLength(8);

		expect(JSON.stringify(viaD1.agenda)).toBe(JSON.stringify(viaLibsql.agenda));
		expect(JSON.stringify(viaD1.events)).toBe(JSON.stringify(viaLibsql.events));
	});

	test("sends only strings as bound params; numbers go in the SQL", async () => {
		fake.paramsLog.length = 0;
		fake.sqlLog.length = 0;
		await listEvents(d1Db, {
			limit: 10,
			offset: 0,
			dateFrom: NOW - DAY,
			dateTo: NOW + 90 * DAY,
			includeUndated: false,
			venueSlug: "teatro-jose-lucio-da-silva",
		});
		expect(fake.sqlLog).toHaveLength(1);
		// The venue slug is a string param; the epoch bounds are literals.
		expect(fake.paramsLog[0]).toEqual(["teatro-jose-lucio-da-silva"]);
		expect(fake.sqlLog[0]).toContain(`>= ${NOW - DAY}`);
		expect(fake.sqlLog[0]).toContain(`<= ${NOW + 90 * DAY}`);
	});

	test("single-row and IN lookups match libSQL, numeric-looking slug included", async () => {
		for (const slug of ["2026", "futuro", "nao-existe"]) {
			expect(await eventBySlug(d1Db, slug)).toEqual(
				await eventBySlug(testDb.db, slug),
			);
		}
		const slugs = ["2026", "ontem", "nao-existe"];
		expect(await eventsBySlugs(d1Db, slugs)).toEqual(
			await eventsBySlugs(testDb.db, slugs),
		);
		expect((await eventBySlug(d1Db, "2026"))?.slug).toBe("2026");
	});

	test("a wrong token fails the read instead of returning an empty snapshot", async () => {
		const bad = createD1ReadDb({
			...FAKE_D1,
			token: "wrong",
			baseUrl: fake.baseUrl,
		});
		// drizzle wraps the driver error ("Failed query: …"); D1Error is its cause.
		await expect(buildSnapshot(bad, NOW_MS)).rejects.toMatchObject({
			cause: { name: "D1Error", status: 403 },
		});
	});
});
