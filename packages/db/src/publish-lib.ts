import type { Database } from "bun:sqlite";

/**
 * Pure pieces of the D1 publish (`publish-d1.ts` → `d1-mirror.ts`), split out
 * so they can be tested without a D1 connection (the script itself runs
 * top-level side effects on import): table classification, the schema
 * guards, SQL literal encoding, insert chunking, the staging DDL rewrite and
 * the single-request swap.
 */

/** Parents first: created / renamed in this order, dropped in reverse. */
export const PUBLISHED_TABLES = [
	"venues",
	"events",
	"event_sources",
	"scrape_runs",
] as const;

/**
 * Local tables that are scraper bookkeeping, never read by the site, and so
 * never published. `event_aliases` maps folded source items to their keeper
 * event (C6); D1 has the (empty) table from the migrations but never needs its
 * rows. Every other local table must be in PUBLISHED_TABLES: a new table fails
 * the publish until it is classified here or there, instead of silently not
 * being mirrored.
 */
export const LOCAL_ONLY_TABLES = ["event_aliases"] as const;

/** SQLite / drizzle / D1 internals, never mirrored. */
export const INTERNAL_TABLE =
	/^(sqlite_|__drizzle|_litestream|libsql_|_cf_|d1_migrations$)/;

/** Suffix of the staging tables the publish loads before the swap. */
export const STAGING_SUFFIX = "_next";

export const stagingName = (table: string) => `${table}${STAGING_SUFFIX}`;

/** Local tables that are neither published nor declared local-only. */
export function findUnclassifiedTables(
	localTables: readonly string[],
	published: readonly string[] = PUBLISHED_TABLES,
	localOnly: readonly string[] = LOCAL_ONLY_TABLES,
): string[] {
	const classified = new Set([...published, ...localOnly]);
	return localTables.filter(
		(name) => !INTERNAL_TABLE.test(name) && !classified.has(name),
	);
}

/** Local columns D1 does not have (the local DB is migrated past D1). */
export function findMissingColumns(
	localColumns: readonly string[],
	remoteColumns: readonly string[],
): string[] {
	const remote = new Set(remoteColumns);
	return localColumns.filter((c) => !remote.has(c));
}

/** An index as `sqlite_master` reports it. */
export type IndexInfo = { name: string; table: string };

/**
 * Every explicit index: `type = 'index'`, minus the `sqlite_autoindex_*` ones
 * SQLite creates on its own for PRIMARY KEY / UNIQUE column constraints (those
 * come with the table and need no migration of their own).
 */
export const INDEX_QUERY =
	"SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'";

/** Normalise a `sqlite_master` row from either driver into an `IndexInfo`. */
export function toIndexInfo(row: { name: unknown; tbl: unknown }): IndexInfo {
	return { name: String(row.name), table: String(row.tbl) };
}

/**
 * Local indexes on the mirrored `tables` that D1 does not have: the
 * "a migration added an index, D1 was never migrated" case. Matched by name,
 * since both sides are built from the same committed drizzle migrations.
 */
export function findMissingIndexes(
	local: readonly IndexInfo[],
	remote: readonly IndexInfo[],
	tables: readonly string[],
): IndexInfo[] {
	const remoteNames = new Set(remote.map((i) => i.name));
	return local.filter(
		(i) => tables.includes(i.table) && !remoteNames.has(i.name),
	);
}

/** The whole remote schema, read in one request. */
export const SCHEMA_QUERY =
	"SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master";

export type SchemaEntry = {
	type: string;
	name: string;
	tbl: string;
	sql: string | null;
};

/** What the publish needs from the remote `sqlite_master`. */
export type RemoteSchema = {
	/** `CREATE TABLE` text per table name. */
	tables: Map<string, string>;
	/** Explicit indexes (with their `CREATE INDEX` text), autoindexes excluded. */
	indexes: (IndexInfo & { sql: string })[];
	/** Triggers, by table: the swap would silently drop them. */
	triggers: IndexInfo[];
};

export function parseRemoteSchema(rows: readonly SchemaEntry[]): RemoteSchema {
	const schema: RemoteSchema = {
		tables: new Map(),
		indexes: [],
		triggers: [],
	};
	for (const row of rows) {
		const name = String(row.name);
		const table = String(row.tbl);
		if (row.type === "table" && row.sql) {
			schema.tables.set(name, String(row.sql));
		} else if (
			row.type === "index" &&
			row.sql &&
			!name.startsWith("sqlite_autoindex_")
		) {
			schema.indexes.push({ name, table, sql: String(row.sql) });
		} else if (row.type === "trigger") {
			schema.triggers.push({ name, table });
		}
	}
	return schema;
}

/** `"name"`, with embedded quotes doubled. */
export function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * One SQLite value as a SQL literal. Inlining (instead of bound parameters)
 * sidesteps D1's 100-parameters-per-statement cap and the REST API's
 * string-typed `params`, and keeps every storage class exact:
 * - integers arrive as `bigint` (the local handle uses `safeIntegers`), so
 *   they print exactly, with no 2^53 rounding;
 * - every JS `number` is a REAL (SQLite hands INTEGERs back as bigint), so it
 *   prints in exponent form (`3.9e+1`), which SQLite always parses as REAL and
 *   `toExponential()` round-trips exactly;
 * - text is single-quoted with quotes doubled (SQLite has no backslash
 *   escapes); blobs print as `X'…'`.
 */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`cannot publish a non-finite number (${value})`);
		}
		return value.toExponential();
	}
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "string") {
		if (value.includes("\u0000")) {
			throw new Error("cannot publish text containing a NUL character");
		}
		return `'${value.replaceAll("'", "''")}'`;
	}
	if (value instanceof Uint8Array) {
		return `X'${Buffer.from(value).toString("hex")}'`;
	}
	throw new Error(`cannot publish a value of type ${typeof value}`);
}

/**
 * D1 rejects statements over 100,000 bytes. The publish stays well under it,
 * leaving headroom for the request envelope.
 */
export const MAX_STATEMENT_BYTES = 90_000;

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Multi-row `INSERT … VALUES (…), (…)` statements for `rows`, each at most
 * `maxBytes` long (UTF-8). A single row that cannot fit fails the publish
 * before anything is written.
 */
export function planInserts(
	table: string,
	columns: readonly string[],
	rows: readonly (readonly unknown[])[],
	maxBytes: number = MAX_STATEMENT_BYTES,
): string[] {
	const head = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES `;
	const headBytes = byteLength(head);
	const statements: string[] = [];
	let tuples: string[] = [];
	let bytes = headBytes;
	for (const [i, row] of rows.entries()) {
		const tuple = `(${row.map(sqlLiteral).join(", ")})`;
		const tupleBytes = byteLength(tuple);
		if (headBytes + tupleBytes > maxBytes) {
			throw new Error(
				`${table} row #${i + 1} is ${tupleBytes} bytes as SQL, over the ${maxBytes}-byte statement budget`,
			);
		}
		const separator = tuples.length > 0 ? 2 : 0;
		if (bytes + separator + tupleBytes > maxBytes) {
			statements.push(head + tuples.join(", "));
			tuples = [];
			bytes = headBytes;
		}
		bytes += (tuples.length > 0 ? 2 : 0) + tupleBytes;
		tuples.push(tuple);
	}
	if (tuples.length > 0) statements.push(head + tuples.join(", "));
	return statements;
}

/** A quoted or bare SQLite identifier. */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;

function unquoteIdent(ident: string): string {
	const first = ident[0];
	if (first === '"') return ident.slice(1, -1).replaceAll('""', '"');
	if (first === "`") return ident.slice(1, -1).replaceAll("``", "`");
	if (first === "[") return ident.slice(1, -1);
	return ident;
}

/**
 * Rewrite a `CREATE TABLE` statement for another table name, and its
 * `REFERENCES` targets per `renames`: the staging copy of `event_sources`
 * must point at `events_next`, so its rows are checked against the staged
 * parents, not the live ones. Handles every quoting style SQLite keeps in
 * `sqlite_master` (drizzle writes backticks; ALTER TABLE RENAME rewrites to
 * double quotes).
 */
export function rewriteCreateTable(
	sql: string,
	newName: string,
	renames: ReadonlyMap<string, string>,
): string {
	const header = new RegExp(
		String.raw`^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(${IDENT})`,
		"i",
	);
	if (!header.test(sql)) {
		throw new Error(`not a CREATE TABLE statement: ${sql.slice(0, 80)}`);
	}
	const renamed = sql.replace(
		header,
		(_m, prefix: string) => `${prefix}${quoteIdent(newName)}`,
	);
	return renamed.replace(
		new RegExp(String.raw`(\bREFERENCES\s+)(${IDENT})`, "gi"),
		(match, prefix: string, ident: string) => {
			const target = renames.get(unquoteIdent(ident));
			return target ? `${prefix}${quoteIdent(target)}` : match;
		},
	);
}

/**
 * Statements that (re)create empty staging tables for `tables` (parents
 * first), from the remote `CREATE TABLE` text: the staging copy has exactly
 * the live table's columns, constraints and foreign keys (redirected to the
 * staged parents). Leftovers of an aborted run are dropped first. Indexes are
 * not staged: they are built inside the swap (index names are schema-global,
 * and SQLite cannot rename an index).
 */
export function planStaging(
	tables: readonly string[],
	remoteTables: ReadonlyMap<string, string>,
): string[] {
	const renames = new Map(tables.map((t) => [t, stagingName(t)]));
	const statements = [...tables]
		.reverse()
		.map((t) => `DROP TABLE IF EXISTS ${quoteIdent(stagingName(t))}`);
	for (const table of tables) {
		const ddl = remoteTables.get(table);
		if (!ddl) throw new Error(`D1 has no ${table} table`);
		statements.push(rewriteCreateTable(ddl, stagingName(table), renames));
	}
	return statements;
}

/**
 * Statements that fail (and so abort the request they are in) unless
 * `table` holds exactly `expected` rows. `json()` raises "malformed JSON" on
 * the non-JSON string, which is the only portable way to raise an error from
 * a plain SELECT outside a trigger.
 */
export function assertCountSql(table: string, expected: number): string {
	return `SELECT CASE WHEN (SELECT count(*) FROM ${quoteIdent(table)}) = ${expected} THEN 1 ELSE json('publish: ${table} row count is not ${expected}') END AS ok`;
}

/**
 * The swap, as ONE request: assert every staging table holds exactly the
 * rows that were loaded, drop the live tables (children first), rename the
 * staging tables into place (parents first; SQLite rewrites the children's
 * `REFERENCES "events_next"` to `"events"` as the parent is renamed), then
 * rebuild the live indexes from their own `CREATE INDEX` text. D1 runs a
 * multi-statement request as one transaction, so readers see either the
 * whole old database or the whole new one, never a mix (see publish-d1.ts).
 */
export function planSwap(
	tables: readonly string[],
	expectedCounts: ReadonlyMap<string, number>,
	indexes: readonly (IndexInfo & { sql: string })[],
): string[] {
	const statements: string[] = [];
	for (const table of tables) {
		const expected = expectedCounts.get(table);
		if (expected === undefined) throw new Error(`no count for ${table}`);
		statements.push(assertCountSql(stagingName(table), expected));
	}
	for (const table of [...tables].reverse()) {
		statements.push(`DROP TABLE ${quoteIdent(table)}`);
	}
	for (const table of tables) {
		statements.push(
			`ALTER TABLE ${quoteIdent(stagingName(table))} RENAME TO ${quoteIdent(table)}`,
		);
	}
	for (const index of indexes) {
		if (tables.includes(index.table)) statements.push(index.sql);
	}
	for (const statement of statements) {
		// The request is split on `;` server-side; DDL never needs one.
		if (statement.includes(";")) {
			throw new Error(`swap statement contains ';': ${statement}`);
		}
	}
	return statements;
}

/**
 * How long scrape_runs history is kept. The site reads only the latest run
 * (`eventStats`); the rest is operator forensics ("did a parser break last
 * week?"), for which a quarter is plenty. The publish mirrors the table to
 * D1 in full, so pruning locally keeps D1 bounded too.
 */
export const SCRAPE_RUNS_RETENTION_DAYS = 90;

/**
 * Delete `scrape_runs` rows older than the retention window, except each
 * source's most recent run: a source that went quiet for months must still
 * show when it last ran (and whether that run failed). Returns rows deleted.
 */
export function pruneScrapeRuns(
	db: Pick<Database, "run">,
	nowSeconds: number,
	retentionDays: number = SCRAPE_RUNS_RETENTION_DAYS,
): number {
	const cutoff = nowSeconds - retentionDays * 86_400;
	return db.run(
		`DELETE FROM scrape_runs
		 WHERE started_at < ?
		   AND id NOT IN (
		     SELECT id FROM (
		       SELECT id, ROW_NUMBER() OVER (
		         PARTITION BY source ORDER BY started_at DESC, id DESC
		       ) AS rn
		       FROM scrape_runs
		     ) WHERE rn = 1
		   )`,
		[cutoff],
	).changes;
}
