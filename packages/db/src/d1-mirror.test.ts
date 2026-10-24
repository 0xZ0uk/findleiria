import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { mirrorToD1, PublishGuardError } from "./d1-mirror";
import {
	createD1Query,
	D1Error,
	type D1Query,
	parseD1Response,
} from "./d1-rest";
import { fakeD1 } from "./fake-d1";
import { INDEX_QUERY, PUBLISHED_TABLES } from "./publish-lib";
import { migratedDb } from "./test-support";

/**
 * Integration: the whole mirror over real HTTP against a fake D1 REST server
 * (Bun.serve + an FK-enforcing SQLite with the committed migrations applied).
 * The fake keeps D1's documented contract: a multi-statement `{ sql }` runs
 * as one transaction (any failing statement rolls the request back), errors
 * are HTTP 400 `{ success: false, errors: [{ code: 7500, … }] }`.
 */

/** A migrated local.db with realistic, awkward data. */
function seededLocal(generation: number, events = 300): Database {
	const db = migratedDb();
	const venues = 25;
	for (let v = 1; v <= venues; v++) {
		db.run(
			"INSERT INTO venues (id, name, slug, address, lat, lng, city, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				v,
				`Venue ${v} d'Ana; "quoted" g${generation}`,
				`venue-${v}`,
				v % 3 ? `Rua ${v}, Leiria` : null,
				39.7 + v / 1000,
				v % 4 ? -8.8 - v / 1000 : 39,
				"Leiria",
				v % 5 ? "venue" : "city",
			],
		);
	}
	let sourceId = 1;
	for (let e = 1; e <= events; e++) {
		db.run(
			"INSERT INTO events (id, title, slug, description, start_at, end_at, venue_id, image_url, url, categories, fingerprint, created_at, updated_at, date_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				e,
				`Concerto nº ${e} — ação 🎉 g${generation}`,
				`evento-${e}`,
				e % 2
					? `Linha 1;\nLinha 2 'x' -- not a comment ${"é".repeat(e % 40)}`
					: null,
				1_800_000_000 + e * 3600,
				e % 3 ? 1_800_000_000 + e * 3600 + 7200 : null,
				e % 7 ? (e % venues) + 1 : null,
				null,
				`https://example.pt/e/${e}?a=1&b=2`,
				JSON.stringify(["música", "teatro"]),
				`fp-${e}`,
				1_700_000_000,
				1_700_000_000 + generation,
				e % 11 ? null : "todo o mês",
			],
		);
		for (const source of e % 2 ? ["a", "b"] : ["a"]) {
			db.run(
				"INSERT INTO event_sources (id, event_id, source, source_event_id, source_url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[sourceId++, e, source, `${source}-${e}`, null, 1_700_000_000, null],
			);
		}
		if (e % 10 === 0) {
			db.run(
				"INSERT INTO event_aliases (source, source_event_id, event_id, created_at) VALUES ('a', ?, ?, 0)",
				[`alias-${e}`, e],
			);
		}
	}
	for (let r = 1; r <= 60; r++) {
		db.run(
			"INSERT INTO scrape_runs (id, source, started_at, finished_at, items_found, error, warnings) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				r,
				`src-${r % 9}`,
				1_800_000_000 - r * 86_400,
				null,
				r,
				r % 13 ? null : "boom; 'x'",
				null,
			],
		);
	}
	return reopen(db);
}

/** The publish reads local.db read-only with safeIntegers; mimic that. */
function reopen(db: Database): Database {
	const bytes = db.serialize();
	db.close();
	return Database.deserialize(bytes, { safeIntegers: true, readonly: true });
}

function dump(db: Database, table: string): unknown[] {
	return db
		.query(`SELECT * FROM "${table}" ORDER BY id`)
		.all()
		.map((row) =>
			Object.fromEntries(
				Object.entries(row as Record<string, unknown>).map(([k, v]) => [
					k,
					typeof v === "bigint" ? Number(v) : v,
				]),
			),
		);
}

const indexNames = (db: Database) =>
	db
		.query<{ name: string }, []>(`${INDEX_QUERY} ORDER BY name`)
		.all()
		.map((r) => r.name);

function expectMirrored(local: Database, remote: Database) {
	for (const table of PUBLISHED_TABLES) {
		expect(dump(remote, table)).toEqual(dump(local, table));
	}
	expect(
		remote
			.query<{ n: number }, []>("SELECT count(*) AS n FROM event_aliases")
			.get()?.n,
	).toBe(0);
	expect(
		remote
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE name LIKE '%_next%'",
			)
			.all(),
	).toEqual([]);
	expect(remote.query("PRAGMA foreign_key_check").all()).toEqual([]);
	expect(indexNames(remote)).toEqual(indexNames(migratedDb()));
}

const quiet = () => {};
const fake = fakeD1();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

describe("mirrorToD1 against a fake D1 REST server", () => {
	test("a full mirror reproduces local.db exactly, twice in a row", async () => {
		const local = seededLocal(1);
		const result = await mirrorToD1(local, fake.d1, {
			log: quiet,
			maxStatementBytes: 20_000,
		});
		expect(Object.fromEntries(result.counts)).toEqual({
			venues: 25,
			events: 300,
			event_sources: 450,
			scrape_runs: 60,
		});
		expect(result.requests).toBeGreaterThan(8);
		expectMirrored(local, fake.remote);

		// Second run: the DDL now carries the rename's double quotes.
		const next = seededLocal(2, 280);
		await mirrorToD1(next, fake.d1, { log: quiet });
		expectMirrored(next, fake.remote);
	});

	test("a failure midway through the load leaves the previous data intact", async () => {
		const first = seededLocal(1);
		await mirrorToD1(first, fake.d1, { log: quiet, maxStatementBytes: 20_000 });
		const before = PUBLISHED_TABLES.map((t) => dump(fake.remote, t));

		const second = seededLocal(2, 250);
		let loads = 0;
		fake.setFault(
			(s) => s.startsWith('INSERT INTO "events_next"') && ++loads === 3,
		);
		await expect(
			mirrorToD1(second, fake.d1, { log: quiet, maxStatementBytes: 20_000 }),
		).rejects.toBeInstanceOf(D1Error);
		expect(PUBLISHED_TABLES.map((t) => dump(fake.remote, t))).toEqual(before);

		// The next run cleans up the half-loaded staging tables and succeeds.
		fake.setFault(null);
		await mirrorToD1(second, fake.d1, { log: quiet });
		expectMirrored(second, fake.remote);
	});

	test("a failure inside the swap rolls the whole swap back", async () => {
		const first = seededLocal(1);
		await mirrorToD1(first, fake.d1, { log: quiet });
		const before = PUBLISHED_TABLES.map((t) => dump(fake.remote, t));

		// Fail on the LAST rename, after the live tables were already dropped
		// and the parents renamed in the same request.
		fake.setFault((s) => s.startsWith('ALTER TABLE "scrape_runs_next"'));
		await expect(
			mirrorToD1(seededLocal(2, 200), fake.d1, { log: quiet }),
		).rejects.toThrow(/injected failure/);
		expect(PUBLISHED_TABLES.map((t) => dump(fake.remote, t))).toEqual(before);
		expect(indexNames(fake.remote)).toEqual(indexNames(migratedDb()));
	});

	test("a lost staging request fails the swap's count check", async () => {
		const first = seededLocal(1);
		await mirrorToD1(first, fake.d1, { log: quiet });
		const before = PUBLISHED_TABLES.map((t) => dump(fake.remote, t));

		// A d1Query that "succeeds" without running one load: the swap's own
		// assertions must notice the staging table is short.
		let dropped = false;
		const lossy: D1Query = async (sql) => {
			if (!dropped && sql.startsWith('INSERT INTO "event_sources_next"')) {
				dropped = true;
				return [{ results: [], success: true, meta: {} }];
			}
			return fake.d1(sql);
		};
		await expect(
			mirrorToD1(seededLocal(2), lossy, {
				log: quiet,
				maxStatementBytes: 20_000,
			}),
		).rejects.toThrow(/malformed JSON/);
		expect(PUBLISHED_TABLES.map((t) => dump(fake.remote, t))).toEqual(before);
	});

	describe("guards refuse before anything is written", () => {
		const expectUntouched = () => {
			expect(fake.sqlLog.some((s) => /INSERT|DROP|CREATE|ALTER/.test(s))).toBe(
				false,
			);
		};

		test("D1 missing a column", async () => {
			fake.remote.run("ALTER TABLE scrape_runs DROP COLUMN postpass_error");
			await expect(
				mirrorToD1(seededLocal(1, 5), fake.d1, { log: quiet }),
			).rejects.toThrow(
				/D1 scrape_runs is missing columns: postpass_error .*db:migrate:remote/s,
			);
			expectUntouched();
		});

		test("D1 missing an index", async () => {
			fake.remote.run("DROP INDEX events_start_at_idx");
			await expect(
				mirrorToD1(seededLocal(1, 5), fake.d1, { log: quiet }),
			).rejects.toThrow(
				/D1 is missing indexes: events_start_at_idx \(events\)/,
			);
			expectUntouched();
		});

		test("D1 missing a table", async () => {
			fake.remote.run("DROP TABLE scrape_runs");
			await expect(
				mirrorToD1(seededLocal(1, 5), fake.d1, { log: quiet }),
			).rejects.toThrow(/D1 has no scrape_runs table/);
			expectUntouched();
		});

		test("a trigger on a published table", async () => {
			fake.remote.run(
				"CREATE TRIGGER t AFTER INSERT ON venues BEGIN SELECT 1; END",
			);
			await expect(
				mirrorToD1(seededLocal(1, 5), fake.d1, { log: quiet }),
			).rejects.toThrow(/triggers on published tables \(t on venues\)/);
			expectUntouched();
		});

		test("an unclassified local table", async () => {
			const local = migratedDb();
			local.run("CREATE TABLE shiny (id INTEGER)");
			await expect(mirrorToD1(local, fake.d1, { log: quiet })).rejects.toThrow(
				/not classified for publishing: shiny/,
			);
			expect(fake.sqlLog).toEqual([]);
		});

		test("orphan rows in local.db", async () => {
			const local = migratedDb();
			local.run(
				"INSERT INTO event_sources (event_id, source, first_seen_at) VALUES (42, 'a', 0)",
			);
			const error = await mirrorToD1(local, fake.d1, { log: quiet }).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(PublishGuardError);
			expect(String(error)).toContain("1 in event_sources → events");
			expect(fake.sqlLog).toEqual([]);
		});
	});
});

describe("parseD1Response", () => {
	test("returns one result per statement", () => {
		expect(
			parseD1Response(
				200,
				JSON.stringify({
					success: true,
					errors: [],
					result: [
						{ results: [{ a: 1 }], success: true, meta: { rows_written: 0 } },
						{ success: true, meta: { rows_written: 3 } },
					],
				}),
			),
		).toEqual([
			{ results: [{ a: 1 }], success: true, meta: { rows_written: 0 } },
			{ results: [], success: true, meta: { rows_written: 3 } },
		]);
	});

	test("surfaces Cloudflare's errors for an SQL failure", () => {
		expect(() =>
			parseD1Response(
				400,
				JSON.stringify({
					success: false,
					errors: [
						{ code: 7500, message: "no such table: nope: SQLITE_ERROR" },
					],
					result: [],
				}),
			),
		).toThrow("D1 query failed (HTTP 400): 7500: no such table: nope");
	});

	test("rejects non-JSON bodies, missing results and failed statements", () => {
		expect(() => parseD1Response(502, "<html>Bad gateway</html>")).toThrow(
			/non-JSON body/,
		);
		expect(() => parseD1Response(200, '{"success":true}')).toThrow(
			/without a result/,
		);
		expect(() =>
			parseD1Response(
				200,
				JSON.stringify({ success: true, result: [{ success: false }] }),
			),
		).toThrow(/statement #1/);
	});

	test("a wrong token is an error, not an empty result", async () => {
		const d1 = createD1Query({
			accountId: "acc",
			databaseId: "db-id",
			token: "wrong",
			baseUrl: fake.baseUrl,
		});
		await expect(d1("SELECT 1")).rejects.toThrow(/HTTP 403/);
	});
});
