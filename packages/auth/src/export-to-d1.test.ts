import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	ExportRefused,
	exportAuthData,
	orderByForeignKeys,
	planTables,
	sourcePathFromArg,
	sqlLiteral,
} from "./export-to-d1";
import {
	compareCounts,
	countsQuery,
	parseCountsFile,
	parseWranglerCounts,
} from "./verify-d1-import";

const dir = mkdtempSync(join(tmpdir(), "findleiria-export-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const migrationsFolder = join(import.meta.dir, "migrations");

/** A libSQL file database migrated with the committed auth migrations. */
async function migratedFile(name: string): Promise<string> {
	const path = join(dir, name);
	const client = createClient({ url: `file:${path}` });
	await migrate(drizzle({ client }), { migrationsFolder });
	client.close();
	return path;
}

const TABLES = [
	"user",
	"account",
	"session",
	"saved_event",
	"verification",
	"rate_limit",
] as const;

const NASTY = [
	"O'Brien",
	"''",
	'"quoted" \\ back\\slash',
	"line1\nline2\r\nline3;\n-- not a comment\n",
	"semi; colon;\nINSERT INTO user VALUES ('x');",
	"João Ç 🎉 中文",
	"tab\there",
	"nul\0inside",
	"",
	"x".repeat(5000),
];

function dump(path: string): Record<string, unknown[]> {
	const db = new Database(path, { readonly: true, safeIntegers: true });
	try {
		return Object.fromEntries(
			TABLES.map((t) => [
				t,
				db.query(`SELECT * FROM "${t}" ORDER BY id`).all() as unknown[],
			]),
		);
	} finally {
		db.close();
	}
}

function seed(path: string): void {
	const db = new Database(path);
	db.run("PRAGMA foreign_keys = ON");
	const T = 1_760_000_000;
	NASTY.forEach((s, i) => {
		db.run(
			"INSERT INTO user (id,name,email,email_verified,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
			[`u${i}`, s, `u${i}@x.pt`, i % 2, i % 3 === 0 ? null : s, T + i, T + i],
		);
		db.run(
			"INSERT INTO account (id,account_id,provider_id,user_id,access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at,scope,password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
			[
				`a${i}`,
				s,
				"credential",
				`u${i}`,
				s,
				null,
				null,
				null,
				null,
				s,
				s,
				T,
				T,
			],
		);
		db.run(
			"INSERT INTO session (id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id) VALUES (?,?,?,?,?,?,?,?)",
			[`s${i}`, T + 99, `tok${i}-${s}`, T, T, null, s, `u${i}`],
		);
		db.run(
			"INSERT INTO saved_event (id,user_id,event_slug,created_at) VALUES (?,?,?,?)",
			[`e${i}`, `u${i}`, `slug-${i}`, T],
		);
		db.run(
			"INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
			[`v${i}`, s, s, T, T, T],
		);
	});
	// Epoch milliseconds past 2^32, and a 64-bit extreme.
	db.run(
		"INSERT INTO rate_limit (id,key,count,last_request) VALUES (?,?,?,?)",
		["r1", "1.2.3.4/api/auth/sign-in/email", 3, 1_760_000_000_123],
	);
	db.run(
		"INSERT INTO rate_limit (id,key,count,last_request) VALUES (?,?,?,?)",
		["r2", "k2", 0, -9_223_372_036_854_775_807n],
	);
	db.close();
}

describe("export-to-d1", () => {
	test("generated SQL reproduces every table exactly on a fresh migrated DB", async () => {
		const source = await migratedFile("source.db");
		seed(source);

		const { sql, counts } = exportAuthData(source);
		expect(counts).toMatchObject({
			user: NASTY.length,
			account: NASTY.length,
			session: NASTY.length,
			saved_event: NASTY.length,
			verification: NASTY.length,
			rate_limit: 2,
		});
		expect(sql).toContain("PRAGMA defer_foreign_keys = true;");
		expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
		// Parents first.
		expect(sql.indexOf('INSERT INTO "user"')).toBeLessThan(
			sql.indexOf('INSERT INTO "session"'),
		);
		expect(sql.indexOf('INSERT INTO "user"')).toBeLessThan(
			sql.indexOf('INSERT INTO "saved_event"'),
		);

		const target = await migratedFile("target.db");
		const client = createClient({ url: `file:${target}` });
		await client.execute("PRAGMA foreign_keys = ON");
		await client.executeMultiple(sql);
		client.close();

		expect(dump(target)).toEqual(dump(source));
	});

	test("rows are batched under the statement limit, and still round-trip", async () => {
		const source = await migratedFile("big.db");
		const db = new Database(source);
		const T = 1_760_000_000;
		db.run("BEGIN");
		for (let i = 0; i < 400; i++) {
			db.run(
				"INSERT INTO user (id,name,email,email_verified,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
				[`u${i}`, "n".repeat(900), `u${i}@x.pt`, 0, null, T, T],
			);
		}
		db.run("COMMIT");
		db.close();

		const { sql } = exportAuthData(source);
		const statements = sql
			.split(/;\n(?=INSERT|$)/)
			.filter((s) => s.startsWith("INSERT"));
		expect(statements.length).toBeGreaterThan(3);
		for (const s of statements) {
			expect(Buffer.byteLength(s)).toBeLessThan(100_000);
		}

		const target = await migratedFile("big-target.db");
		const client = createClient({ url: `file:${target}` });
		await client.executeMultiple(sql);
		client.close();
		expect(dump(target)).toEqual(dump(source));
	});

	test("an empty database exports no INSERTs and zero counts", async () => {
		const source = await migratedFile("empty.db");
		const { sql, counts } = exportAuthData(source);
		expect(sql).not.toContain("INSERT");
		expect(Object.values(counts).every((n) => n === 0)).toBe(true);
	});

	test("skips bookkeeping tables such as __drizzle_migrations", async () => {
		const source = await migratedFile("skip.db");
		const db = new Database(source);
		db.run("CREATE TABLE libsql_wasm_func_table (x)");
		db.run("CREATE TABLE _litestream_seq (x)");
		db.close();
		const { counts } = exportAuthData(source);
		expect(Object.keys(counts).sort()).toEqual([...TABLES].sort());
	});

	test("refuses a source with an extra table", async () => {
		const source = await migratedFile("extra-table.db");
		const db = new Database(source);
		db.run("CREATE TABLE audit_log (id text)");
		db.close();
		expect(() => exportAuthData(source)).toThrow(/audit_log/);
	});

	test("refuses a source with an extra column", async () => {
		const source = await migratedFile("extra-col.db");
		const db = new Database(source);
		db.run("ALTER TABLE user ADD COLUMN phone text");
		db.close();
		expect(() => exportAuthData(source)).toThrow(/column "phone"/);
	});

	test("refuses a source that lacks a column, and prints the fix", async () => {
		const source = await migratedFile("missing-col.db");
		const db = new Database(source);
		db.run("ALTER TABLE user DROP COLUMN image");
		db.close();
		let message = "";
		try {
			exportAuthData(source);
		} catch (error) {
			expect(error).toBeInstanceOf(ExportRefused);
			message = (error as Error).message;
		}
		expect(message).toMatch(/lacks column "image"/);
		expect(message).toMatch(/Fix:/);
	});

	test("refuses a source that lacks a table, naming the unapplied migration", async () => {
		const source = await migratedFile("missing-table.db");
		const db = new Database(source);
		db.run("DROP TABLE rate_limit");
		// Pretend the last migration was never applied.
		db.run(
			"DELETE FROM __drizzle_migrations WHERE id = (SELECT max(id) FROM __drizzle_migrations)",
		);
		db.close();
		expect(() => exportAuthData(source)).toThrow(
			/lacks table "rate_limit"[\s\S]*0002_rate_limit/,
		);
	});
});

describe("export helpers", () => {
	test("tables come out parents first and a cycle is refused", () => {
		const order = orderByForeignKeys(planTables()).map((p) => p.name);
		expect(order.indexOf("user")).toBeLessThan(order.indexOf("session"));
		expect(order.indexOf("user")).toBeLessThan(order.indexOf("account"));
		expect(order.indexOf("user")).toBeLessThan(order.indexOf("saved_event"));
		expect([...order].sort()).toEqual([...TABLES].sort());

		expect(() =>
			orderByForeignKeys([
				{ name: "a", columns: [], parents: ["b"] },
				{ name: "b", columns: [], parents: ["a"] },
			]),
		).toThrow(/cycle/);
	});

	test("literals", () => {
		expect(sqlLiteral(null)).toBe("NULL");
		expect(sqlLiteral(12n)).toBe("12");
		expect(sqlLiteral(1.5)).toBe("1.5");
		expect(sqlLiteral(2)).toBe("2.0");
		expect(sqlLiteral("it's")).toBe("'it''s'");
		expect(sqlLiteral(new Uint8Array([0, 255, 16]))).toBe("x'00ff10'");
		expect(sqlLiteral("a\0b")).toBe("CAST(x'610062' AS TEXT)");
	});

	test("blobs and reals survive the round trip", () => {
		const source = join(dir, "exotic.db");
		const raw = new Database(source);
		raw.run("CREATE TABLE t (id integer primary key, a, b, c)");
		raw.run("INSERT INTO t VALUES (1, x'00ff80', 0.1, 1e300)");
		raw.close();
		const read = new Database(source, { safeIntegers: true });
		const row = read.query("SELECT * FROM t").values()[0] as unknown[];
		read.close();
		const target = new Database(":memory:");
		target.run("CREATE TABLE t (id integer primary key, a, b, c)");
		target.run(`INSERT INTO t VALUES (${row.map(sqlLiteral).join(",")})`);
		expect(
			target.query("SELECT hex(a), b, c, typeof(b) FROM t").values()[0],
		).toEqual(["00FF80", 0.1, 1e300, "real"]);
	});

	test("--from accepts file: paths only", () => {
		expect(sourcePathFromArg("file:/tmp/x.db")).toBe("/tmp/x.db");
		expect(() => sourcePathFromArg("libsql://db.turso.io")).toThrow(
			/local SQLite file/,
		);
	});
});

describe("verify-d1-import", () => {
	test("compares counts and parses wrangler --json output", () => {
		const { tables } = parseCountsFile(
			JSON.stringify({ tables: { user: 2, session: 1 } }),
		);
		expect(countsQuery(Object.keys(tables))).toContain("count(*)");

		const wrangler = `wrangler 4\n[{"results":[{"user":2,"session":1}],"success":true,"meta":{}}]`;
		const actual = parseWranglerCounts(wrangler);
		expect(compareCounts(tables, actual).ok).toBe(true);
		expect(compareCounts(tables, { ...actual, session: 0 }).ok).toBe(false);
		expect(compareCounts(tables, { user: 2 }).lines.join()).toContain(
			"missing",
		);
	});

	test("rejects table names that are not plain identifiers", () => {
		expect(() =>
			parseCountsFile(
				JSON.stringify({ tables: { 'user"; DROP TABLE x;--': 1 } }),
			),
		).toThrow(/Refusing/);
	});
});
