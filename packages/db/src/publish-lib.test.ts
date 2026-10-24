import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	findMissingIndexes,
	INDEX_QUERY,
	pruneScrapeRuns,
	toIndexInfo,
} from "./publish-lib";

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("findMissingIndexes", () => {
	const tables = ["events", "scrape_runs"];

	test("reports local indexes Turso lacks", () => {
		const local = [
			{ name: "events_start_idx", table: "events" },
			{ name: "events_new_idx", table: "events" },
		];
		const remote = [{ name: "events_start_idx", table: "events" }];
		expect(findMissingIndexes(local, remote, tables)).toEqual([
			{ name: "events_new_idx", table: "events" },
		]);
	});

	test("ignores tables that are not mirrored and extra remote indexes", () => {
		const local = [{ name: "event_aliases_idx", table: "event_aliases" }];
		const remote = [{ name: "stale_remote_idx", table: "events" }];
		expect(findMissingIndexes(local, remote, tables)).toEqual([]);
	});
});

describe("INDEX_QUERY", () => {
	test("lists explicit indexes only, not sqlite_autoindex_*", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT UNIQUE, b TEXT)");
		db.run("CREATE INDEX t_b_idx ON t (b)");
		const rows = db
			.query<{ name: string; tbl: string }, []>(INDEX_QUERY)
			.all()
			.map(toIndexInfo);
		expect(rows).toEqual([{ name: "t_b_idx", table: "t" }]);
	});
});

describe("pruneScrapeRuns", () => {
	function seed() {
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE scrape_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at INTEGER NOT NULL)",
		);
		const insert = (source: string, daysAgo: number) =>
			db.run("INSERT INTO scrape_runs (source, started_at) VALUES (?, ?)", [
				source,
				NOW - daysAgo * DAY,
			]);
		insert("a", 200); // old, not latest: pruned
		insert("a", 100); // old, not latest: pruned
		insert("a", 10); // recent: kept
		insert("b", 400); // old but the only run of b: kept
		insert("c", 95); // old, not latest: pruned
		insert("c", 91); // old but c's latest: kept
		return db;
	}

	const remaining = (db: Database) =>
		db
			.query<{ source: string }, []>(
				"SELECT source FROM scrape_runs ORDER BY id",
			)
			.all()
			.map((r) => r.source);

	test("drops rows past the window but keeps each source's latest run", () => {
		const db = seed();
		expect(pruneScrapeRuns(db, NOW, 90)).toBe(3);
		expect(remaining(db)).toEqual(["a", "b", "c"]);
	});

	test("is idempotent", () => {
		const db = seed();
		pruneScrapeRuns(db, NOW, 90);
		expect(pruneScrapeRuns(db, NOW, 90)).toBe(0);
	});
});
