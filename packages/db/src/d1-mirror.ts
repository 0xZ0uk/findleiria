import type { Database } from "bun:sqlite";

import type { D1Query, D1StatementResult } from "./d1-rest";
import {
	findMissingColumns,
	findMissingIndexes,
	findUnclassifiedTables,
	INDEX_QUERY,
	LOCAL_ONLY_TABLES,
	MAX_STATEMENT_BYTES,
	PUBLISHED_TABLES,
	parseRemoteSchema,
	planInserts,
	planStaging,
	planSwap,
	quoteIdent,
	SCHEMA_QUERY,
	type SchemaEntry,
	stagingName,
	toIndexInfo,
} from "./publish-lib";

/**
 * The D1 mirror itself, behind an injectable `D1Query` so tests can run it
 * against a fake D1. `publish-d1.ts` wires it to the real REST API.
 *
 * Shape (why it is atomic: see publish-d1.ts):
 *   1. guards, all before any write: unclassified local tables, local
 *      foreign-key violations, D1 missing a table, column or index, triggers
 *      a swap would drop;
 *   2. stage: (re)create empty `<table>_next` copies of the live tables;
 *   3. load: one INSERT statement per request into the staging tables (as
 *      many requests as the data needs; readers never see these tables);
 *   4. swap: ONE request that checks every staging count, drops the live
 *      tables, renames the staging ones into place and rebuilds the indexes.
 * A failure in 1–3 leaves the live tables untouched; 4 commits whole or not
 * at all.
 */

/** A guard failed: nothing was written to D1. */
export class PublishGuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PublishGuardError";
	}
}

export const MIGRATE_HINT =
	"Migrate D1 once, from the repo root (uses your `wrangler login`, or CLOUDFLARE_API_TOKEN=<D1_RW_API_TOKEN> with CLOUDFLARE_ACCOUNT_ID):\n  pnpm --filter @events-tracker/db db:migrate:remote";

export type MirrorResult = {
	counts: Map<string, number>;
	/** Sum of D1's `rows_written` over every request (staging + swap). */
	rowsWritten: number;
	/** `rows_written` of the swap request alone. */
	swapRowsWritten: number;
	requests: number;
};

export type MirrorOptions = {
	tables?: readonly string[];
	localOnly?: readonly string[];
	maxStatementBytes?: number;
	log?: (line: string) => void;
};

const sumWritten = (results: readonly D1StatementResult[]) =>
	results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0);

/**
 * Mirror `local` (opened with `safeIntegers: true`, so integers stay exact)
 * into D1. Throws PublishGuardError when a guard refuses (nothing written),
 * or the D1 error of the failing request (live data untouched unless the
 * swap committed, in which case this resolves).
 */
export async function mirrorToD1(
	local: Database,
	d1: D1Query,
	options: MirrorOptions = {},
): Promise<MirrorResult> {
	const tables = options.tables ?? PUBLISHED_TABLES;
	const localOnly = options.localOnly ?? LOCAL_ONLY_TABLES;
	const log = options.log ?? console.log;
	let requests = 0;
	let rowsWritten = 0;
	const query = async (sql: string) => {
		requests++;
		const results = await d1(sql);
		rowsWritten += sumWritten(results);
		return results;
	};

	// --- 1. Guards (local) ---------------------------------------------------
	const localTables = local
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		)
		.all()
		.map((t) => t.name);
	const unclassified = findUnclassifiedTables(localTables, tables, localOnly);
	if (unclassified.length > 0) {
		throw new PublishGuardError(
			`Local tables not classified for publishing: ${unclassified.join(", ")} — add them to PUBLISHED_TABLES or LOCAL_ONLY_TABLES in publish-lib.ts.`,
		);
	}
	const missingLocal = tables.filter((t) => !localTables.includes(t));
	if (missingLocal.length > 0) {
		throw new PublishGuardError(
			`The local DB has no ${missingLocal.join(", ")} table — run db:migrate on it first.`,
		);
	}

	// D1 enforces foreign keys; the scraper's local handle does not. An orphan
	// row would fail the staging load with a bare "FOREIGN KEY constraint
	// failed", so name it here instead.
	const orphans = local
		.query<{ table: string; parent: string }, []>("PRAGMA foreign_key_check")
		.all()
		.filter((v) => tables.includes(v.table));
	if (orphans.length > 0) {
		const byTable = new Map<string, number>();
		for (const o of orphans) {
			const key = `${o.table} → ${o.parent}`;
			byTable.set(key, (byTable.get(key) ?? 0) + 1);
		}
		throw new PublishGuardError(
			`The local DB has rows whose foreign key points at nothing (${[...byTable]
				.map(([k, n]) => `${n} in ${k}`)
				.join(
					", ",
				)}); D1 enforces foreign keys, so they cannot be published. Fix them locally (PRAGMA foreign_key_check).`,
		);
	}

	// --- 1. Guards (remote) --------------------------------------------------
	const schemaRows = (await query(SCHEMA_QUERY))[0]?.results ?? [];
	const remote = parseRemoteSchema(schemaRows as SchemaEntry[]);

	const missingTables = tables.filter((t) => !remote.tables.has(t));
	if (missingTables.length > 0) {
		throw new PublishGuardError(
			`D1 has no ${missingTables.join(", ")} table — it was never migrated. ${MIGRATE_HINT}`,
		);
	}

	// Indexes first, for all tables, so the guidance covers everything at once.
	// Indexes carry no data, but a migration that adds one must reach D1 too,
	// or its queries silently scan.
	const localIndexes = local
		.query<{ name: string; tbl: string }, []>(INDEX_QUERY)
		.all()
		.map(toIndexInfo);
	const missingIndexes = findMissingIndexes(
		localIndexes,
		remote.indexes,
		tables,
	);
	if (missingIndexes.length > 0) {
		throw new PublishGuardError(
			`D1 is missing indexes: ${missingIndexes.map((i) => `${i.name} (${i.table})`).join(", ")} — the local DB is migrated past D1. ${MIGRATE_HINT}`,
		);
	}

	const triggers = remote.triggers.filter((t) => tables.includes(t.table));
	if (triggers.length > 0) {
		throw new PublishGuardError(
			`D1 has triggers on published tables (${triggers.map((t) => `${t.name} on ${t.table}`).join(", ")}); the table swap would drop them. Teach publish-lib.ts planSwap to recreate them first.`,
		);
	}

	const columnsByTable = new Map<string, string[]>();
	for (const table of tables) {
		const remoteColumns = (
			(await query(`PRAGMA table_info(${quoteIdent(table)})`))[0]?.results ?? []
		).map((r) => String(r.name));
		const columns = local
			.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(table)})`)
			.all()
			.map((c) => c.name);
		const missing = findMissingColumns(columns, remoteColumns);
		if (missing.length > 0) {
			// Every column is mirrored (the site's build selects the full drizzle
			// schema, so D1 must have them all): apply the same committed
			// migrations to D1 once.
			throw new PublishGuardError(
				`D1 ${table} is missing columns: ${missing.join(", ")} — the local DB is migrated past D1. ${MIGRATE_HINT}`,
			);
		}
		columnsByTable.set(table, columns);
	}

	// --- Plan (still nothing written) -----------------------------------------
	const counts = new Map<string, number>();
	const loads: string[] = [];
	for (const table of tables) {
		const columns = columnsByTable.get(table) ?? [];
		const rows = local
			.query(
				`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`,
			)
			.values() as unknown[][];
		counts.set(table, rows.length);
		const statements = planInserts(
			stagingName(table),
			columns,
			rows,
			options.maxStatementBytes ?? MAX_STATEMENT_BYTES,
		);
		loads.push(...statements);
		log(
			`${table}: ${rows.length} rows, ${columns.length} columns → ${statements.length} insert statement(s)`,
		);
	}
	const swap = planSwap(tables, counts, remote.indexes);

	// --- 2. Stage, 3. load ---------------------------------------------------
	await query(planStaging(tables, remote.tables).join(";\n"));
	for (const statement of loads) await query(statement);

	// --- 4. Swap: the only request that touches live tables ------------------
	const before = rowsWritten;
	await query(swap.join(";\n"));
	return {
		counts,
		rowsWritten,
		swapRowsWritten: rowsWritten - before,
		requests,
	};
}

/** The site-facing counts, read back from D1 after the swap. */
export const POST_PUBLISH_QUERY = (now: number) =>
	`SELECT (SELECT count(*) FROM events) AS total, (SELECT count(*) FROM events WHERE date_text IS NULL AND start_at >= ${Math.floor(now)}) AS upcoming, (SELECT count(*) FROM venues) AS venues, (SELECT count(*) FROM event_sources) AS event_sources, (SELECT count(*) FROM scrape_runs) AS scrape_runs`;
