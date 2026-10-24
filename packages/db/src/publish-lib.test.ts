import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	findMissingColumns,
	findMissingIndexes,
	findUnclassifiedTables,
	INDEX_QUERY,
	PUBLISHED_TABLES,
	parseRemoteSchema,
	planInserts,
	planStaging,
	planSwap,
	pruneScrapeRuns,
	rewriteCreateTable,
	SCHEMA_QUERY,
	type SchemaEntry,
	sqlLiteral,
	toIndexInfo,
} from "./publish-lib";
import { migratedDb } from "./test-support";

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("findMissingIndexes", () => {
	const tables = ["events", "scrape_runs"];

	test("reports local indexes D1 lacks", () => {
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

describe("findUnclassifiedTables", () => {
	test("flags a new local table, ignores internals and classified ones", () => {
		expect(
			findUnclassifiedTables(
				[
					"venues",
					"events",
					"event_aliases",
					"sqlite_sequence",
					"__drizzle_migrations",
					"d1_migrations",
					"_cf_KV",
					"shiny_new_table",
				],
				["venues", "events"],
				["event_aliases"],
			),
		).toEqual(["shiny_new_table"]);
	});
});

describe("findMissingColumns", () => {
	test("reports local columns D1 lacks, tolerates extra remote ones", () => {
		expect(findMissingColumns(["id", "a", "b"], ["id", "b", "extra"])).toEqual([
			"a",
		]);
	});
});

describe("parseRemoteSchema", () => {
	test("splits tables, explicit indexes and triggers", () => {
		const schema = parseRemoteSchema([
			{ type: "table", name: "t", tbl: "t", sql: "CREATE TABLE t (id)" },
			{ type: "index", name: "sqlite_autoindex_t_1", tbl: "t", sql: null },
			{
				type: "index",
				name: "t_idx",
				tbl: "t",
				sql: "CREATE INDEX t_idx ON t (id)",
			},
			{ type: "trigger", name: "t_trg", tbl: "t", sql: "CREATE TRIGGER x" },
		]);
		expect([...schema.tables.keys()]).toEqual(["t"]);
		expect(schema.indexes).toEqual([
			{ name: "t_idx", table: "t", sql: "CREATE INDEX t_idx ON t (id)" },
		]);
		expect(schema.triggers).toEqual([{ name: "t_trg", table: "t" }]);
	});
});

describe("sqlLiteral", () => {
	test("encodes every storage class", () => {
		expect(sqlLiteral(null)).toBe("NULL");
		expect(sqlLiteral(9007199254740993n)).toBe("9007199254740993");
		expect(sqlLiteral("it's")).toBe("'it''s'");
		expect(sqlLiteral(new Uint8Array([0, 255]))).toBe("X'00ff'");
		expect(sqlLiteral(39)).toBe("3.9e+1");
	});

	test("round-trips through SQLite with the same type and value", () => {
		const db = new Database(":memory:", { safeIntegers: true });
		const values: unknown[] = [
			null,
			0n,
			-1n,
			9223372036854775807n,
			39.0,
			-8.807,
			0.1,
			1e21,
			5e-324,
			"",
			"a'b; DROP TABLE x; --",
			'quote " and \\ backslash',
			"emoji 🎉 ç",
			new Uint8Array([1, 2, 3]),
		];
		const typeOf = (v: unknown) =>
			v === null
				? "null"
				: typeof v === "bigint"
					? "integer"
					: typeof v === "number"
						? "real"
						: typeof v === "string"
							? "text"
							: "blob";
		for (const v of values) {
			const literal = sqlLiteral(v);
			const row = db
				.query<{ v: unknown; t: string }, []>(
					`SELECT ${literal} AS v, typeof(${literal}) AS t`,
				)
				.get();
			expect(row?.v).toEqual(v);
			expect(row?.t).toBe(typeOf(v));
		}
	});

	test("refuses values it cannot write as literals", () => {
		expect(() => sqlLiteral(Number.NaN)).toThrow();
		expect(() => sqlLiteral("a\u0000b")).toThrow();
		expect(() => sqlLiteral({})).toThrow();
	});
});

describe("planInserts", () => {
	const rows = Array.from({ length: 50 }, (_, i) => [BigInt(i), `row ${i}`]);

	test("chunks rows under the byte budget and keeps every row", () => {
		const statements = planInserts("t_next", ["id", "name"], rows, 300);
		expect(statements.length).toBeGreaterThan(1);
		for (const s of statements) {
			expect(Buffer.byteLength(s)).toBeLessThanOrEqual(300);
			expect(s).toStartWith('INSERT INTO "t_next" ("id", "name") VALUES (');
		}
		const db = new Database(":memory:");
		db.run("CREATE TABLE t_next (id INTEGER PRIMARY KEY, name TEXT)");
		for (const s of statements) db.run(s);
		expect(
			db.query<{ n: number }, []>("SELECT count(*) AS n FROM t_next").get()?.n,
		).toBe(50);
	});

	test("no rows, no statements", () => {
		expect(planInserts("t", ["id"], [])).toEqual([]);
	});

	test("a row too large for one statement fails the plan", () => {
		expect(() => planInserts("t", ["v"], [["x".repeat(500)]], 300)).toThrow(
			/row #1/,
		);
	});
});

describe("rewriteCreateTable", () => {
	const renames = new Map([
		["events", "events_next"],
		["venues", "venues_next"],
	]);

	test("renames drizzle's backtick DDL and redirects mirrored references", () => {
		const sql =
			"CREATE TABLE `event_sources` (\n\t`id` integer PRIMARY KEY,\n\t`event_id` integer NOT NULL,\n\tFOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE cascade\n)";
		expect(rewriteCreateTable(sql, "event_sources_next", renames)).toBe(
			'CREATE TABLE "event_sources_next" (\n\t`id` integer PRIMARY KEY,\n\t`event_id` integer NOT NULL,\n\tFOREIGN KEY (`event_id`) REFERENCES "events_next"(`id`) ON DELETE cascade\n)',
		);
	});

	test("handles the double-quoted text ALTER TABLE RENAME leaves behind", () => {
		const sql =
			'CREATE TABLE "events" (id integer, venue_id integer REFERENCES "venues"(id), other_id integer REFERENCES other(id))';
		expect(rewriteCreateTable(sql, "events_next", renames)).toBe(
			'CREATE TABLE "events_next" (id integer, venue_id integer REFERENCES "venues_next"(id), other_id integer REFERENCES other(id))',
		);
	});

	test("refuses anything that is not CREATE TABLE", () => {
		expect(() =>
			rewriteCreateTable("CREATE VIEW v AS SELECT 1", "x", renames),
		).toThrow();
	});
});

describe("planStaging + planSwap on the real migrated schema", () => {
	const tables = PUBLISHED_TABLES;
	const zero = new Map<string, number>(tables.map((t) => [t, 0]));
	const remoteSchema = (db: Database) =>
		parseRemoteSchema(db.query<SchemaEntry, []>(SCHEMA_QUERY).all());
	const stage = (db: Database) => {
		for (const s of planStaging(tables, remoteSchema(db).tables)) db.run(s);
	};
	// One transaction, as D1 runs the swap request.
	const swapIn = (db: Database, counts: Map<string, number>) => {
		const statements = planSwap(tables, counts, remoteSchema(db).indexes);
		db.transaction(() => {
			for (const s of statements) db.run(s);
		})();
	};
	const names = (db: Database, sql: string) =>
		db
			.query<{ name: string }, []>(sql)
			.all()
			.map((r) => r.name);

	test("staging copies keep constraints and point at the staged parents", () => {
		const db = migratedDb({ foreignKeys: true });
		stage(db);
		db.run("INSERT INTO venues_next (id, name, slug) VALUES (1, 'V', 'v')");
		const insertEvent = (venueId: number) =>
			db.run(
				`INSERT INTO events_next (id, title, slug, start_at, venue_id, fingerprint, created_at, updated_at) VALUES (1, 'E', 'e', 0, ${venueId}, 'f', 0, 0)`,
			);
		expect(() => insertEvent(2)).toThrow(/FOREIGN KEY/);
		insertEvent(1);
		// Column defaults come along with the DDL.
		expect(
			db.query<{ c: string }, []>("SELECT city AS c FROM venues_next").get()?.c,
		).toBe("Leiria");
	});

	test("the swap puts staged rows live with the same indexes and FKs", () => {
		const db = migratedDb({ foreignKeys: true });
		const indexesBefore = names(db, `${INDEX_QUERY} ORDER BY name`);
		db.run("INSERT INTO venues (id, name, slug) VALUES (9, 'Old', 'old')");
		stage(db);
		db.run("INSERT INTO venues_next (id, name, slug) VALUES (1, 'New', 'new')");
		swapIn(db, new Map([...zero, ["venues", 1]]));

		expect(names(db, "SELECT name FROM venues")).toEqual(["New"]);
		expect(names(db, `${INDEX_QUERY} ORDER BY name`)).toEqual(indexesBefore);
		expect(
			names(db, "SELECT name FROM sqlite_master WHERE name LIKE '%_next%'"),
		).toEqual([]);
		expect(
			db
				.query<{ table: string }, []>("PRAGMA foreign_key_list(event_sources)")
				.get()?.table,
		).toBe("events");

		// A second publish starts from the double-quoted DDL the rename left.
		stage(db);
		swapIn(db, zero);
		expect(names(db, "SELECT name FROM venues")).toEqual([]);
		expect(names(db, `${INDEX_QUERY} ORDER BY name`)).toEqual(indexesBefore);
	});

	test("a wrong staging count aborts the whole swap", () => {
		const db = migratedDb({ foreignKeys: true });
		db.run("INSERT INTO venues (id, name, slug) VALUES (9, 'Old', 'old')");
		stage(db);
		expect(() => swapIn(db, new Map([...zero, ["venues", 5]]))).toThrow(
			/malformed JSON/,
		);
		expect(names(db, "SELECT name FROM venues")).toEqual(["Old"]);
	});

	test("refuses a swap statement containing ';'", () => {
		expect(() =>
			planSwap(["t"], new Map([["t", 0]]), [
				{ name: "i", table: "t", sql: "CREATE INDEX i ON t (a); DROP TABLE x" },
			]),
		).toThrow(/';'/);
	});
});
