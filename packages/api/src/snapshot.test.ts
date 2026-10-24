import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Db, schema } from "@events-tracker/db/client";

import { WINDOW_MAX } from "./queries/events";
import {
	assertFileSafeSlug,
	buildSnapshot,
	type Snapshot,
	writeSnapshot,
} from "./snapshot";
import {
	AGENDA_WINDOW_DAYS,
	SNAPSHOT_LOOKBACK_DAYS,
	SNAPSHOT_SLACK_DAYS,
	SNAPSHOT_VERSION,
} from "./snapshot-shape";
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
 * The snapshot builder against a real libSQL file with the committed
 * migrations applied (see `./test-db.ts`): the window bounds, the joins and the
 * session merge run as SQL, not as a stand-in.
 */

let tmp: string;
let testDb: TestDb;
let db: Db;
let snapshot: Snapshot;

beforeAll(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "findleiria-snapshot-out-"));
	testDb = await createTestDb("findleiria-snapshot-");
	db = testDb.db;

	await db.insert(schema.venues).values({
		id: 1,
		name: "Teatro José Lúcio da Silva",
		slug: "teatro-jose-lucio-da-silva",
		city: "Leiria",
		lat: 39.7467,
		lng: -8.8039,
		scope: "venue",
	});
	await db.insert(schema.events).values([
		// Long past: outside the agenda, still a page and a saved row.
		event(1, "ja-passou", NOW - 30 * DAY),
		// Yesterday: inside the lookback, so a reader whose clock lags still has it.
		event(2, "ontem", NOW - DAY),
		// Two sessions of one show, same Lisbon day: one agenda row.
		event(3, "concerto-18h", NOW + 2 * DAY, { title: "Concerto" }),
		event(4, "concerto-21h", NOW + 2 * DAY + 3 * 3600, { title: "Concerto" }),
		// Past the 90-day window but within the slack.
		event(5, "na-folga", NOW + (AGENDA_WINDOW_DAYS + 3) * DAY),
		// Past the slack: not in the agenda file.
		event(6, "longe-demais", NOW + (AGENDA_WINDOW_DAYS + 30) * DAY),
		// Undated: its own list, never in the days.
		event(7, "sem-data", NOW, { date_text: "Brevemente" }),
	]);
	await db.insert(schema.scrapeRuns).values([
		{ source: "leiriagenda", started_at: NOW - 2 * DAY, items_found: 9 },
		{ source: "leiriagenda", started_at: NOW - 3600, items_found: 12 },
	]);

	snapshot = await buildSnapshot(db, NOW_MS);
});

afterAll(() => {
	testDb.cleanup();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildSnapshot", () => {
	test("covers the lookback, the window and the slack, and says so", () => {
		expect(snapshot.agenda.version).toBe(SNAPSHOT_VERSION);
		expect(snapshot.agenda.generatedAt).toBe(NOW);
		expect(snapshot.agenda.covers).toEqual({
			from: NOW - SNAPSHOT_LOOKBACK_DAYS * DAY,
			to: NOW + (AGENDA_WINDOW_DAYS + SNAPSHOT_SLACK_DAYS) * DAY,
		});
		expect(snapshot.agenda.events.map((e) => e.slug)).toEqual([
			"ontem",
			"concerto-18h",
			"na-folga",
		]);
	});

	test("merges same-day sessions into one agenda row", () => {
		const concerto = snapshot.agenda.events.find((e) => e.title === "Concerto");
		expect(concerto?.sessionStarts).toEqual([
			NOW + 2 * DAY,
			NOW + 2 * DAY + 3 * 3600,
		]);
	});

	test("keeps descriptions out of the agenda file", () => {
		for (const row of snapshot.agenda.events) {
			expect("description" in row).toBe(false);
		}
	});

	test("carries the undated announcements separately", () => {
		expect(snapshot.agenda.undated.map((e) => e.slug)).toEqual(["sem-data"]);
		expect(snapshot.agenda.undated[0]?.dateText).toBe("Brevemente");
	});

	test("carries the masthead's last run", () => {
		expect(snapshot.agenda.stats).toMatchObject({
			totalEvents: 7,
			totalVenues: 1,
			lastRunAt: NOW - 3600,
			lastRunFound: 12,
		});
		expect(snapshot.agenda.truncated).toBe(false);
	});

	test("lists every event, past ones included, with its description", () => {
		expect(snapshot.events).toHaveLength(7);
		const past = snapshot.events.find((e) => e.slug === "ja-passou");
		expect(past).toMatchObject({
			description: "Descrição de ja-passou",
			updatedAt: NOW - DAY,
			venueName: "Teatro José Lúcio da Silva",
		});
	});
});

/**
 * `truncated` must mean rows were really dropped: exactly WINDOW_MAX events
 * fit and is not truncation; one more is.
 */
describe("truncated", () => {
	async function windowWith(count: number) {
		const t = await createTestDb("findleiria-trunc-");
		try {
			await t.db.insert(schema.venues).values({
				id: 1,
				name: "Teatro",
				slug: "teatro",
				city: "Leiria",
				scope: "venue",
			});
			// Distinct titles, so nothing merges.
			const rows = Array.from({ length: count }, (_, i) =>
				event(i + 1, `e-${i}`, NOW + 3600 + i * 60, {
					title: `Título único ${i}`,
				}),
			);
			await insertEvents(t.db, rows);
			return await buildSnapshot(t.db, NOW_MS);
		} finally {
			t.cleanup();
		}
	}

	test("is false at exactly WINDOW_MAX events", async () => {
		const s = await windowWith(WINDOW_MAX);
		expect(s.agenda.events).toHaveLength(WINDOW_MAX);
		expect(s.agenda.truncated).toBe(false);
	}, 60_000);

	test("is true one past WINDOW_MAX, and the file stays capped", async () => {
		const s = await windowWith(WINDOW_MAX + 1);
		expect(s.agenda.events).toHaveLength(WINDOW_MAX);
		expect(s.agenda.truncated).toBe(true);
	}, 60_000);
});

describe("writeSnapshot", () => {
	test("writes the agenda and one file per event, replacing an older run", () => {
		const dir = path.join(tmp, "out");
		fs.mkdirSync(path.join(dir, "events"), { recursive: true });
		fs.writeFileSync(path.join(dir, "events", "apagado.json"), "{}");

		const written = writeSnapshot(dir, snapshot);

		expect(written.files).toBe(1 + 7);
		expect(written.bytes).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(dir, "events", "apagado.json"))).toBe(false);

		const agenda = JSON.parse(
			fs.readFileSync(path.join(dir, "agenda.json"), "utf8"),
		);
		expect(agenda.events).toHaveLength(3);
		const one = JSON.parse(
			fs.readFileSync(path.join(dir, "events", "ja-passou.json"), "utf8"),
		);
		expect(one.description).toBe("Descrição de ja-passou");
	});
});

describe("assertFileSafeSlug", () => {
	test("accepts the slugs the scraper emits", () => {
		expect(() => assertFileSafeSlug("concerto-de-verao-2026")).not.toThrow();
	});

	test.each(["", ".", "..", "../fora", "a/b", "a\\b", " espaço"])(
		"refuses %p",
		(slug) => {
			expect(() => assertFileSafeSlug(slug)).toThrow();
		},
	);
});
