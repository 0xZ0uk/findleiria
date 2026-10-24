import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadDb, type Db, schema } from "@events-tracker/db/client";
import { migrate } from "drizzle-orm/libsql/migrator";

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

/**
 * The snapshot builder against a real libSQL file with the committed
 * migrations applied. The query tests stub drizzle, so this is where the SQL
 * itself (the window bounds, the joins, the session merge) runs for real.
 */

const MIGRATIONS = path.resolve(import.meta.dir, "../../db/src/migrations");
const DAY = 86_400;
/** A fixed build clock: 2026-10-24 12:00 UTC. */
const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
const NOW = NOW_MS / 1000;

let tmp: string;
let db: Db;
let snapshot: Snapshot;

function event(
	id: number,
	slug: string,
	start_at: number,
	extra: Partial<typeof schema.events.$inferInsert> = {},
): typeof schema.events.$inferInsert {
	return {
		id,
		slug,
		title: extra.title ?? `Evento ${slug}`,
		description: `Descrição de ${slug}`,
		start_at,
		venue_id: 1,
		categories: ["Música"],
		fingerprint: `fp-${slug}`,
		updated_at: NOW - DAY,
		...extra,
	};
}

beforeAll(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "findleiria-snapshot-"));
	db = createReadDb(`file:${path.join(tmp, "test.db")}`);
	await migrate(db, { migrationsFolder: MIGRATIONS });

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
	db.$client.close();
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
