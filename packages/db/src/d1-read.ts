import { drizzle } from "drizzle-orm/sqlite-proxy";

import { createD1Raw } from "./d1-rest";
import * as schema from "./schema";

/**
 * The build's read-only view of the events database on D1: drizzle's
 * `sqlite-proxy` driver over the D1 REST `/raw` endpoint (rows come back as
 * arrays, which is the shape the proxy maps). Plain fetch, so it also runs in
 * Node (the web build) and Bun.
 *
 * Used with a read-only D1 token (`D1_READ_API_TOKEN`); the builder only ever
 * selects, and the token enforces it.
 */

/**
 * D1 REST types `params` as an array of strings, so a bound number would
 * arrive as TEXT. That is harmless next to an INTEGER column (SQLite applies
 * the column's affinity to the operand) but not next to an expression, a
 * `LIMIT` or a number-valued function, where text and integer compare
 * differently. So non-string parameters are written into the SQL as exact
 * literals and only strings are bound: a string stays a string (a slug like
 * "2026" must not turn into a number), a number stays a number.
 *
 * Walks the SQL skipping quoted text and comments, and replaces each `?`
 * placeholder. Drizzle emits plain `?` (never `?NNN`, `:name` or `@name`).
 */
export function inlineParams(
	sql: string,
	params: readonly unknown[],
): { sql: string; params: string[] } {
	const bound: string[] = [];
	let out = "";
	let next = 0;
	let i = 0;
	while (i < sql.length) {
		const c = sql[i] as string;
		if (c === "'" || c === '"' || c === "`" || c === "[") {
			const close = c === "[" ? "]" : c;
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === close) {
					// A doubled quote is an escaped one (not for [ ]).
					if (close !== "]" && sql[j + 1] === close) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			out += sql.slice(i, j + 1);
			i = j + 1;
		} else if (c === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			const stop = end === -1 ? sql.length : end;
			out += sql.slice(i, stop);
			i = stop;
		} else if (c === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			const stop = end === -1 ? sql.length : end + 2;
			out += sql.slice(i, stop);
			i = stop;
		} else if (c === "?") {
			if (next >= params.length) {
				throw new Error("D1 read: more `?` placeholders than parameters");
			}
			const value = params[next++];
			if (typeof value === "string") {
				bound.push(value);
				out += "?";
			} else {
				out += literal(value);
			}
			i++;
		} else {
			out += c;
			i++;
		}
	}
	if (next !== params.length) {
		throw new Error("D1 read: more parameters than `?` placeholders");
	}
	return { sql: out, params: bound };
}

/** A non-string parameter as an SQL literal. Negatives are parenthesised so `a -?` cannot become a `--` comment. */
function literal(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "bigint") return value < 0n ? `(${value})` : `${value}`;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`D1 read: cannot bind ${value}`);
		}
		// String(n) is the shortest text that parses back to the same double.
		return value < 0 || Object.is(value, -0) ? `(${value})` : `${value}`;
	}
	if (value instanceof Uint8Array) {
		return `x'${Buffer.from(value).toString("hex")}'`;
	}
	throw new Error(`D1 read: cannot bind a ${typeof value} parameter`);
}

export type D1ReadOptions = {
	accountId: string;
	databaseId: string;
	/** A read-only D1 token. */
	token: string;
	/** For tests: a fake server. Defaults to the Cloudflare API. */
	baseUrl?: string;
	fetch?: typeof fetch;
	/** For tests: replace the real wait and jitter of the 429/5xx retries. */
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
};

/**
 * A drizzle database over D1 REST. Every query is one `/raw` request. Has no
 * `$client` to close: there is no connection.
 */
export function createD1ReadDb(options: D1ReadOptions) {
	const raw = createD1Raw(options);
	return drizzle(
		async (sql, params, method) => {
			const bound = inlineParams(sql, params);
			const [result] = await raw(bound.sql, bound.params);
			const rows = result?.rows ?? [];
			// `run` has nothing to map; `get` wants the single row itself.
			if (method === "run") return { rows: [] };
			return { rows: method === "get" ? (rows[0] as unknown[]) : rows };
		},
		{ schema },
	);
}
