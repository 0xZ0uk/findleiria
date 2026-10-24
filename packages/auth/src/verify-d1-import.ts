/**
 * Cutover check: compares the per-table row counts written by export-to-d1.ts
 * (`<out>.counts.json`) with what the D1 database holds after the import.
 *
 *   pnpm --filter @events-tracker/auth db:verify-d1 -- --counts ../../auth-d1.sql.counts.json
 *
 * It runs `wrangler d1 execute findleiria-auth --remote --json` itself, so the
 * only credential involved is the operator's own `wrangler login` (or a
 * CLOUDFLARE_API_TOKEN already in their shell). Nothing is read from a file,
 * logged or embedded. One read-only SELECT of counts is sent.
 *
 *   --local [--persist-to <dir>]   check a local D1 (wrangler dev state) instead
 *   --result <file>                skip wrangler; compare a saved copy of
 *                                  `wrangler d1 execute … --json` output
 *
 * Exit code 0 only when every table matches exactly.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DB_NAME = "findleiria-auth";
const IDENT = /^[a-z][a-z0-9_]*$/;

export interface CountsFile {
	tables: Record<string, number>;
}

export interface Comparison {
	ok: boolean;
	lines: string[];
}

export function parseCountsFile(text: string): CountsFile {
	const data = JSON.parse(text) as Partial<CountsFile>;
	const tables = data.tables;
	if (
		!tables ||
		typeof tables !== "object" ||
		Object.keys(tables).length === 0
	) {
		throw new Error("The counts file has no `tables` object.");
	}
	for (const [name, n] of Object.entries(tables)) {
		// Table names go into SQL below, so only plain identifiers are accepted.
		if (!IDENT.test(name)) throw new Error(`Refusing table name "${name}".`);
		if (!Number.isInteger(n) || n < 0) {
			throw new Error(`Bad row count for "${name}": ${String(n)}.`);
		}
	}
	return { tables };
}

/**
 * One SELECT returning a single row with a column per table. Scalar subqueries
 * rather than UNION ALL: D1 caps the terms of a compound SELECT below the
 * number of tables here ("too many terms in compound SELECT").
 */
export function countsQuery(tables: string[]): string {
	return `SELECT ${tables
		.map((t) => `(SELECT count(*) FROM "${t}") AS "${t}"`)
		.join(", ")}`;
}

/** Pull the one counts row out of `wrangler d1 execute --json` output. */
export function parseWranglerCounts(output: string): Record<string, number> {
	const start = output.indexOf("[");
	if (start < 0) throw new Error("No JSON in wrangler's output.");
	const parsed = JSON.parse(output.slice(start)) as {
		results?: Record<string, number>[];
	}[];
	const row = parsed.flatMap((r) => r.results ?? [])[0];
	if (!row) throw new Error("wrangler returned no rows.");
	return Object.fromEntries(
		Object.entries(row).map(([table, n]) => [table, Number(n)]),
	);
}

export function compareCounts(
	expected: Record<string, number>,
	actual: Record<string, number>,
): Comparison {
	let ok = true;
	const lines: string[] = [];
	for (const [table, want] of Object.entries(expected)) {
		const got = actual[table];
		const match = got === want;
		if (!match) ok = false;
		lines.push(
			`${match ? "ok      " : "MISMATCH"} ${table.padEnd(14)} export ${want}  d1 ${got ?? "missing"}`,
		);
	}
	return { ok, lines };
}

function parseArgs(argv: string[]) {
	const opts = {
		counts: undefined as string | undefined,
		result: undefined as string | undefined,
		local: false,
		persistTo: undefined as string | undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--counts") opts.counts = argv[++i];
		else if (arg === "--result") opts.result = argv[++i];
		else if (arg === "--local") opts.local = true;
		else if (arg === "--persist-to") opts.persistTo = argv[++i];
		else throw new Error(`Unknown argument "${arg}".`);
	}
	if (!opts.counts) {
		throw new Error(
			"Usage: db:verify-d1 -- --counts <file.counts.json> [--local [--persist-to <dir>]] [--result <saved wrangler json>]",
		);
	}
	return { ...opts, counts: opts.counts };
}

function main(): void {
	const opts = parseArgs(process.argv.slice(2));
	const { tables } = parseCountsFile(
		readFileSync(resolve(opts.counts), "utf8"),
	);

	let output: string;
	if (opts.result) {
		output = readFileSync(resolve(opts.result), "utf8");
	} else {
		const args = [
			"d1",
			"execute",
			DB_NAME,
			opts.local ? "--local" : "--remote",
			"--config",
			resolve(import.meta.dir, "../../../wrangler.jsonc"),
			"--json",
			"--command",
			countsQuery(Object.keys(tables)),
		];
		if (opts.persistTo) args.push("--persist-to", resolve(opts.persistTo));
		const run = spawnSync("wrangler", args, { encoding: "utf8" });
		if (run.error || run.status !== 0) {
			console.error(
				run.stderr || run.stdout || String(run.error ?? `exit ${run.status}`),
			);
			console.error(
				"wrangler failed. Check `wrangler whoami`, or save the JSON of a manual run and pass it with --result.",
			);
			process.exit(1);
		}
		output = run.stdout;
	}

	const { ok, lines } = compareCounts(tables, parseWranglerCounts(output));
	console.log(lines.join("\n"));
	if (!ok) {
		console.error(
			"\nRow counts differ. Do not flip traffic. Fix and re-run the import (see docs/cloudflare-cutover.md, step 5).",
		);
		process.exit(1);
	}
	console.log("\nAll tables match.");
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
