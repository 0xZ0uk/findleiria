/**
 * One-off cutover tool: turns a LOCAL SQLite copy of the old (Turso) auth
 * database into a data-only SQL file for the new D1 database.
 *
 *   bun src/export-to-d1.ts --from file:../../auth-export.db --out ../../auth-d1.sql
 *   wrangler d1 execute findleiria-auth --remote --file ../../auth-d1.sql
 *
 * Why a script and not `.dump`: D1 is already migrated (`db:migrate:remote`),
 * so only rows are copied, never schema; and a raw dump carries `BEGIN` /
 * `COMMIT` (D1 rejects them), `__drizzle_migrations`, `libsql_*` internals and
 * statements that can exceed D1's 100 KB statement limit. The runbook is
 * docs/cloudflare-cutover.md.
 *
 * Deliberately NOT routed through AUTH_DATABASE_URL: that variable is the dev
 * database, and pointing a tool that reads "the auth database" at a path taken
 * from the environment is how the wrong file gets exported. The source is an
 * explicit argument and is opened read-only; no network is involved.
 *
 * Safety checks, all before a single byte is written:
 *  - the source's tables and columns must match the drizzle schema exactly
 *    (a missing or extra table/column refuses, with the fix);
 *  - the schema's foreign keys must be acyclic (parents are emitted first).
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as authSchema from "./schema.js";

/** Tables that are bookkeeping of some other tool, never application data. */
const SKIPPED_TABLE =
	/^(__drizzle_migrations|sqlite_.*|libsql_.*|_litestream.*|d1_migrations|_cf_.*)$/;

/**
 * Cloudflare documents no number for the statement size on the D1 page, but
 * the platform limit is 100 KB (SQLITE_TOOBIG beyond it). Multi-row INSERTs
 * stay under BATCH_BYTES; a single row may use up to MAX_STATEMENT_BYTES.
 */
const BATCH_BYTES = 90_000;
const MAX_STATEMENT_BYTES = 99_000;

export interface TablePlan {
	name: string;
	columns: string[];
	/** Names of the tables this one has a foreign key to (self-references excluded). */
	parents: string[];
}

export interface ExportResult {
	sql: string;
	counts: Record<string, number>;
}

export class ExportRefused extends Error {}

type SchemaModule = Record<string, unknown>;

/** The tables of the drizzle schema, with their columns and FK parents. */
export function planTables(schema: SchemaModule = authSchema): TablePlan[] {
	const plans: TablePlan[] = [];
	for (const value of Object.values(schema)) {
		if (!is(value, SQLiteTable)) continue;
		const config = getTableConfig(value);
		const parents = new Set<string>();
		for (const fk of config.foreignKeys) {
			const parent = getTableConfig(fk.reference().foreignTable).name;
			if (parent !== config.name) parents.add(parent);
		}
		plans.push({
			name: config.name,
			columns: config.columns.map((c) => c.name),
			parents: [...parents],
		});
	}
	return plans;
}

/** Parents before children (stable: schema order breaks ties). Throws on a cycle. */
export function orderByForeignKeys(plans: TablePlan[]): TablePlan[] {
	const byName = new Map(plans.map((p) => [p.name, p]));
	const ordered: TablePlan[] = [];
	const state = new Map<string, "visiting" | "done">();

	const visit = (plan: TablePlan, trail: string[]): void => {
		const seen = state.get(plan.name);
		if (seen === "done") return;
		if (seen === "visiting") {
			throw new ExportRefused(
				`Foreign keys form a cycle (${[...trail, plan.name].join(" -> ")}); the export order cannot be derived.`,
			);
		}
		state.set(plan.name, "visiting");
		for (const parent of plan.parents) {
			const parentPlan = byName.get(parent);
			if (!parentPlan) {
				throw new ExportRefused(
					`Table "${plan.name}" references "${parent}", which is not in the schema.`,
				);
			}
			visit(parentPlan, [...trail, plan.name]);
		}
		state.set(plan.name, "done");
		ordered.push(plan);
	};

	for (const plan of plans) visit(plan, []);
	return ordered;
}

/** Migration files the source has not applied, for the refusal message. */
function pendingMigrationHint(source: Database): string {
	const dir = resolve(import.meta.dir, "migrations");
	let tags: string[] = [];
	try {
		const journal = JSON.parse(
			readFileSync(resolve(dir, "meta", "_journal.json"), "utf8"),
		) as { entries: { tag: string }[] };
		tags = journal.entries.map((e) => e.tag);
	} catch {
		// Fall through to the generic hint.
	}

	let applied = 0;
	try {
		const row = source
			.query("SELECT count(*) AS n FROM __drizzle_migrations")
			.get() as { n: number | bigint } | null;
		applied = Number(row?.n ?? 0);
	} catch {
		// No __drizzle_migrations table: nothing is known to be applied.
	}

	const pending = tags.slice(applied);
	const files = (pending.length > 0 ? pending : tags)
		.map((tag) => `packages/auth/src/migrations/${tag}.sql`)
		.join(", ");
	return [
		"Fix: bring the LOCAL COPY up to the repo's schema, then export again:",
		`  sqlite3 <the --from file> < <migration file>   (in order; candidates: ${files || "see packages/auth/src/migrations"})`,
		"The copy is disposable; never run this against the production Turso database.",
	].join("\n");
}

/** Compare the source's real structure with the schema; throw on any drift. */
function assertSameStructure(source: Database, plans: TablePlan[]): void {
	const sourceTables = (
		source
			.query("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as { name: string }[]
	)
		.map((r) => r.name)
		.filter((name) => !SKIPPED_TABLE.test(name));

	const problems: string[] = [];
	const expected = new Set(plans.map((p) => p.name));

	for (const name of sourceTables) {
		if (!expected.has(name)) {
			problems.push(
				`the source has table "${name}", which the current schema (packages/auth/src/schema.ts) does not have`,
			);
		}
	}
	for (const plan of plans) {
		if (!sourceTables.includes(plan.name)) {
			problems.push(`the source lacks table "${plan.name}"`);
			continue;
		}
		const have = (
			source.query(`PRAGMA table_info("${plan.name}")`).all() as {
				name: string;
			}[]
		).map((c) => c.name);
		for (const col of have) {
			if (!plan.columns.includes(col)) {
				problems.push(
					`table "${plan.name}": the source has column "${col}", which the current schema lacks`,
				);
			}
		}
		for (const col of plan.columns) {
			if (!have.includes(col)) {
				problems.push(
					`table "${plan.name}": the source lacks column "${col}", which the current schema has`,
				);
			}
		}
	}

	if (problems.length > 0) {
		throw new ExportRefused(
			`The source database does not match the current auth schema:\n  - ${problems.join("\n  - ")}\n${pendingMigrationHint(source)}`,
		);
	}
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** One SQLite value as a SQL literal that round-trips exactly. */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	switch (typeof value) {
		case "bigint":
			return value.toString();
		case "number": {
			// bun:sqlite with safeIntegers returns a number only for REAL values.
			if (Number.isNaN(value)) return "NULL";
			if (value === Number.POSITIVE_INFINITY) return "9e999";
			if (value === Number.NEGATIVE_INFINITY) return "-9e999";
			const text = String(value);
			// Keep a REAL a REAL: "1" would be read back as an integer.
			return /^-?\d+$/.test(text) ? `${text}.0` : text;
		}
		case "string":
			// A NUL cannot sit inside a '…' literal; go through a blob cast.
			if (value.includes("\0")) {
				return `CAST(x'${hex(Buffer.from(value, "utf8"))}' AS TEXT)`;
			}
			return `'${value.replaceAll("'", "''")}'`;
		case "object":
			if (value instanceof Uint8Array) return `x'${hex(value)}'`;
			break;
	}
	throw new ExportRefused(`Cannot export a value of type ${typeof value}.`);
}

/** Read the source and build the whole import file. Pure apart from reading it. */
export function exportAuthData(
	sourcePath: string,
	schema: SchemaModule = authSchema,
): ExportResult {
	const plans = orderByForeignKeys(planTables(schema));

	if (!existsSync(sourcePath)) {
		throw new ExportRefused(`No such file: ${sourcePath}`);
	}
	const source = new Database(sourcePath, {
		readonly: true,
		safeIntegers: true,
	});
	try {
		assertSameStructure(source, plans);

		const lines: string[] = [
			"-- FindLeiria auth data, generated by packages/auth/src/export-to-d1.ts.",
			"-- Data only: the schema comes from `db:migrate:remote`. No transaction statements (D1 rejects them).",
			"PRAGMA defer_foreign_keys = true;",
		];
		const counts: Record<string, number> = {};

		for (const plan of plans) {
			const columnList = plan.columns.map(quoteIdent).join(", ");
			const prefix = `INSERT INTO ${quoteIdent(plan.name)} (${columnList}) VALUES\n`;
			const rows = source
				.query(`SELECT ${columnList} FROM ${quoteIdent(plan.name)}`)
				.values() as unknown[][];
			counts[plan.name] = rows.length;

			let batch: string[] = [];
			let batchBytes = Buffer.byteLength(prefix);
			const flush = (): void => {
				if (batch.length === 0) return;
				lines.push(`${prefix}${batch.join(",\n")};`);
				batch = [];
				batchBytes = Buffer.byteLength(prefix);
			};

			for (const row of rows) {
				const tuple = `(${row.map(sqlLiteral).join(", ")})`;
				const tupleBytes = Buffer.byteLength(tuple) + 2;
				if (Buffer.byteLength(prefix) + tupleBytes + 1 > MAX_STATEMENT_BYTES) {
					throw new ExportRefused(
						`A row of "${plan.name}" (id ${String(row[0])}) is ${tupleBytes} bytes; D1 statements are limited to 100 KB.`,
					);
				}
				if (batch.length > 0 && batchBytes + tupleBytes > BATCH_BYTES) flush();
				batch.push(tuple);
				batchBytes += tupleBytes;
			}
			flush();
		}

		return { sql: `${lines.join("\n")}\n`, counts };
	} finally {
		source.close();
	}
}

/** `file:/abs/x.db`, `file:rel/x.db` or a plain path -> a filesystem path. */
export function sourcePathFromArg(from: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(from) && !from.startsWith("file:")) {
		throw new ExportRefused(
			`--from must be a local SQLite file (file:…), got "${from.split(":")[0]}:…". Turn the Turso database into a local file first (docs/cloudflare-cutover.md, step 5).`,
		);
	}
	const path = from.startsWith("file:") ? from.slice("file:".length) : from;
	return resolve(path.replace(/^\/\//, "/"));
}

function parseArgs(argv: string[]): { from: string; out: string } {
	let from: string | undefined;
	let out: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--from") from = argv[++i];
		else if (arg?.startsWith("--from=")) from = arg.slice("--from=".length);
		else if (arg === "--out") out = argv[++i];
		else if (arg?.startsWith("--out=")) out = arg.slice("--out=".length);
		else throw new ExportRefused(`Unknown argument "${arg}".`);
	}
	if (!from || !out) {
		throw new ExportRefused(
			"Usage: bun src/export-to-d1.ts --from file:<local sqlite file> --out <file.sql>",
		);
	}
	return { from, out };
}

if (import.meta.main) {
	try {
		const { from, out } = parseArgs(process.argv.slice(2));
		const { sql, counts } = exportAuthData(sourcePathFromArg(from));
		const outPath = resolve(out);
		writeFileSync(outPath, sql);
		const countsPath = `${outPath}.counts.json`;
		writeFileSync(
			countsPath,
			`${JSON.stringify({ generatedAt: new Date().toISOString(), tables: counts }, null, "\t")}\n`,
		);
		console.log("Rows exported per table (parents first):");
		for (const [table, n] of Object.entries(counts)) {
			console.log(`  ${table.padEnd(14)} ${n}`);
		}
		console.log(`\nSQL:    ${outPath} (${Buffer.byteLength(sql)} bytes)`);
		console.log(`Counts: ${countsPath}`);
		console.log(
			"\nNext: wrangler d1 execute findleiria-auth --remote --file <the SQL file>, then `pnpm --filter @events-tracker/auth db:verify-d1 -- --counts <the counts file>`.",
		);
	} catch (error) {
		console.error(error instanceof ExportRefused ? error.message : error);
		process.exit(1);
	}
}
