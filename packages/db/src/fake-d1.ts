import type { Database } from "bun:sqlite";

import { createD1Query } from "./d1-rest";
import { migratedDb } from "./test-support";

/**
 * Test-only: a fake D1 REST server (Bun.serve + an FK-enforcing SQLite with
 * the committed migrations applied). Shared by the publish tests and the
 * build-snapshot equivalence test. It keeps D1's documented contract: a
 * multi-statement `{ sql }` runs as one transaction (any failing statement
 * rolls the request back), errors are HTTP 400
 * `{ success: false, errors: [{ code: 7500, … }] }`, and bound `params` are
 * strings only (anything else is refused, as the API schema says).
 *
 * Endpoints: `/query` (rows as objects) and `/raw` (`{ columns, rows }`, rows
 * as arrays).
 */

/** Split on `;` outside quotes/comments, as D1 does server-side. */
export function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i] as string;
		if (quote) {
			cur += c;
			if (c === quote) {
				if (sql[i + 1] === quote) cur += sql[++i];
				else quote = null;
			}
		} else if (c === "'" || c === '"' || c === "`") {
			quote = c;
			cur += c;
		} else if (c === ";") {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
		} else {
			cur += c;
		}
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

export type Fault = (statement: string, request: number) => boolean;

export const FAKE_D1 = {
	accountId: "acc",
	databaseId: "db-id",
	token: "test-token",
} as const;

/** What D1 looks like after `wrangler d1 migrations apply`. */
export function freshRemote(): Database {
	const db = migratedDb({ foreignKeys: true });
	db.run("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)");
	db.run("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)");
	return db;
}

export function fakeD1() {
	let remote = freshRemote();
	let fault: Fault | null = null;
	let requests = 0;
	const sqlLog: string[] = [];
	/** The bound params of every request, in order (for asserting what was sent). */
	const paramsLog: unknown[][] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const base = `/accounts/${FAKE_D1.accountId}/d1/database/${FAKE_D1.databaseId}`;
			const endpoint = url.pathname.endsWith(`${base}/query`)
				? "query"
				: url.pathname.endsWith(`${base}/raw`)
					? "raw"
					: null;
			if (
				req.headers.get("authorization") !== `Bearer ${FAKE_D1.token}` ||
				!endpoint
			) {
				return Response.json(
					{ success: false, errors: [{ code: 10000, message: "auth" }] },
					{ status: 403 },
				);
			}
			const body = (await req.json()) as { sql: string; params?: unknown[] };
			const { sql } = body;
			const params = body.params ?? [];
			const request = ++requests;
			sqlLog.push(sql);
			paramsLog.push(params);
			if (!params.every((p) => typeof p === "string")) {
				return Response.json(
					{
						success: false,
						errors: [{ code: 7400, message: "params must be strings" }],
						messages: [],
					},
					{ status: 400 },
				);
			}
			try {
				const run = remote.transaction(() =>
					splitStatements(sql).map((statement) => {
						if (fault?.(statement, request)) {
							throw new Error(`injected failure at request ${request}`);
						}
						const q = remote.query(statement);
						// D1 binds `params` to the (single) statement's placeholders.
						const bound = params as string[];
						const meta = (changes: number) => ({ rows_written: changes });
						const rows =
							endpoint === "raw"
								? (q.values(...bound) as unknown[][])
								: (q.all(...bound) as Record<string, unknown>[]);
						const changes =
							remote.query<{ n: number }, []>("SELECT changes() AS n").get()
								?.n ?? 0;
						return {
							results:
								endpoint === "raw" ? { columns: q.columnNames, rows } : rows,
							success: true,
							meta: meta(changes),
						};
					}),
				);
				return Response.json({
					success: true,
					errors: [],
					messages: [],
					result: run(),
				});
			} catch (err) {
				return Response.json(
					{
						success: false,
						errors: [{ code: 7500, message: String(err) }],
						messages: [],
					},
					{ status: 400 },
				);
			}
		},
	});
	const baseUrl = `http://localhost:${server.port}`;
	/** The publish-side client (`/query`), pointed at this fake. */
	const d1 = createD1Query({ ...FAKE_D1, baseUrl });
	return {
		d1,
		baseUrl,
		get remote() {
			return remote;
		},
		reset() {
			remote = freshRemote();
			fault = null;
			sqlLog.length = 0;
			paramsLog.length = 0;
		},
		setFault(f: Fault | null) {
			fault = f;
		},
		sqlLog,
		paramsLog,
		stop: () => server.stop(true),
	};
}
