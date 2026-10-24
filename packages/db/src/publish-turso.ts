/**
 * Mirror the local SQLite DB into Turso — the database the deployed site
 * actually reads.
 *
 * Nothing else publishes `local.db`: the scraper writes local SQLite, the site
 * reads Turso, and until this runs the two drift apart (the site keeps serving
 * an older copy of the district — that is why the calendar showed 211 events
 * after a run that had ingested 434). Full-table mirror in FK order inside a
 * single write transaction, so a half-published DB is impossible; counts are
 * printed on both sides.
 *
 * The site does not read Turso at runtime: its build turns Turso into a static
 * JSON snapshot. So a publish only reaches readers once Vercel rebuilds, and
 * when `VERCEL_DEPLOY_HOOK_URL` is set this run asks for that rebuild after
 * the mirror has committed. A failed hook exits non-zero (the data is safe in
 * Turso; the site is just still serving the previous build).
 *
 *   bun run db:publish                    # from packages/db, uses the repo .env
 *   DATABASE_URL=… TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun run db:publish
 *
 * The daily job (`pnpm --filter server daily`) runs this after the scrape.
 * Schema: every local column of the mirrored tables is published, so Turso
 * must be migrated as far as local.db (`db:migrate` against Turso, see the
 * README); a missing column or index fails the publish before anything is
 * written (indexes carry no data, but a migration that adds one must reach
 * Turso too, or its queries silently scan).
 *
 * Retention: scrape_runs older than 90 days are pruned from local.db first
 * (each source keeps its latest run), and the mirror carries that to Turso.
 */
import { Database } from "bun:sqlite";

import { createClient } from "@libsql/client";

import {
	findMissingIndexes,
	INDEX_QUERY,
	pruneScrapeRuns,
	SCRAPE_RUNS_RETENTION_DAYS,
	toIndexInfo,
} from "./publish-lib";

/** Parents first: inserts in this order, deletes in reverse. */
const TABLES = ["venues", "events", "event_sources", "scrape_runs"] as const;

type Table = (typeof TABLES)[number];

/**
 * Local tables that are scraper bookkeeping, never read by the site, and so
 * never published. `event_aliases` maps folded source items to their keeper
 * event (C6); Turso does not need it and may not even have the table. Every
 * other local table must be in TABLES: a new table fails the publish until it
 * is classified here or there, instead of silently not being mirrored.
 */
const LOCAL_ONLY_TABLES = ["event_aliases"] as const;

/** SQLite / drizzle internals, never mirrored. */
const INTERNAL_TABLE = /^(sqlite_|__drizzle|_litestream|libsql_)/;

const databaseUrl = process.env.DATABASE_URL ?? "";
const localPath = databaseUrl.replace(/^file:/, "");
const tursoUrl = process.env.TURSO_DATABASE_URL;
// Turso hands out per-token permissions: the site's read token is read-only,
// so publishing needs the read/write one (TURSO_RW_TOKEN in the credentials
// file). Fall back to TURSO_AUTH_TOKEN for a single-token setup.
const tursoToken = process.env.TURSO_RW_TOKEN ?? process.env.TURSO_AUTH_TOKEN;

if (localPath === "" || localPath === databaseUrl) {
	console.error(
		"db:publish needs DATABASE_URL as a local file URL (file:…/local.db).",
	);
	process.exit(1);
}
if (!tursoUrl || !tursoToken) {
	console.error("db:publish needs TURSO_DATABASE_URL and TURSO_RW_TOKEN.");
	process.exit(1);
}

// Retention first, through a short-lived writable handle: the mirror itself
// reads local.db read-only. Housekeeping must never block a publish.
try {
	const writable = new Database(localPath);
	const pruned = pruneScrapeRuns(writable, Math.floor(Date.now() / 1000));
	writable.close();
	if (pruned > 0) {
		console.log(
			`scrape_runs: pruned ${pruned} rows older than ${SCRAPE_RUNS_RETENTION_DAYS} days`,
		);
	}
} catch (err) {
	console.warn("scrape_runs retention skipped:", err);
}

const local = new Database(localPath, { readonly: true });

const classified: readonly string[] = [...TABLES, ...LOCAL_ONLY_TABLES];
const unclassified = local
	.query<{ name: string }, []>(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	)
	.all()
	.map((t) => t.name)
	.filter((name) => !INTERNAL_TABLE.test(name) && !classified.includes(name));
if (unclassified.length > 0) {
	console.error(
		`Local tables not classified for publishing: ${unclassified.join(", ")} — add them to TABLES or LOCAL_ONLY_TABLES in publish-turso.ts.`,
	);
	process.exit(1);
}

const turso = createClient({ url: tursoUrl, authToken: tursoToken });

const statements: { sql: string; args: (string | number | null)[] }[] = [];
for (const table of [...TABLES].reverse()) {
	statements.push({ sql: `DELETE FROM ${table}`, args: [] });
}

// Indexes first, for all tables, so the guidance covers everything at once.
const localIndexes = local
	.query<{ name: string; tbl: string }, []>(INDEX_QUERY)
	.all()
	.map(toIndexInfo);
const remoteIndexes = (await turso.execute(INDEX_QUERY)).rows.map((r) =>
	toIndexInfo({ name: r.name, tbl: r.tbl }),
);
const missingIndexes = findMissingIndexes(localIndexes, remoteIndexes, TABLES);
if (missingIndexes.length > 0) {
	console.error(
		`Turso is missing indexes: ${missingIndexes.map((i) => `${i.name} (${i.table})`).join(", ")} — the local DB is migrated past Turso. Migrate Turso once, from the repo root:\n  DATABASE_URL='<TURSO_DATABASE_URL>' TURSO_AUTH_TOKEN='<TURSO_RW_TOKEN>' pnpm --filter @events-tracker/db db:migrate`,
	);
	process.exit(1);
}

const counts = new Map<Table, number>();
for (const table of TABLES) {
	const remote = (await turso.execute(`PRAGMA table_info(${table})`)).rows;
	const remoteColumns = remote.map((r) => String(r.name));
	const columns = local
		.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
		.all()
		.map((c) => c.name);
	if (remoteColumns.length === 0) {
		console.error(`Turso has no ${table} table — run db:push first.`);
		process.exit(1);
	}
	const missing = columns.filter((c) => !remoteColumns.includes(c));
	if (missing.length > 0) {
		// The local DB was migrated past Turso's schema. Every column is
		// mirrored (the site's build selects the full drizzle schema, so Turso
		// must have them all): apply the same committed migrations to Turso
		// once, with the read/write token.
		console.error(
			`Turso ${table} is missing columns: ${missing.join(", ")} — the local DB is migrated past Turso. Migrate Turso once, from the repo root:\n  DATABASE_URL='<TURSO_DATABASE_URL>' TURSO_AUTH_TOKEN='<TURSO_RW_TOKEN>' pnpm --filter @events-tracker/db db:migrate`,
		);
		process.exit(1);
	}

	const rows = local
		.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`)
		.all();
	counts.set(table, rows.length);
	const placeholders = columns.map(() => "?").join(", ");
	for (const row of rows) {
		statements.push({
			sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
			args: columns.map((c) => {
				const value = row[c];
				return typeof value === "bigint" ? Number(value) : (value as never);
			}),
		});
	}
	console.log(
		`${table}: ${rows.length} rows, ${remote.length} columns → mirrored`,
	);
}

const started = Date.now();
await turso.batch(statements, "write");
console.log(
	`published ${statements.length - TABLES.length} rows to Turso in ${Date.now() - started}ms`,
);

const now = Math.floor(Date.now() / 1000);
const check = await turso.execute(
	"SELECT (SELECT count(*) FROM events) AS total, (SELECT count(*) FROM events WHERE date_text IS NULL AND start_at >= ?) AS upcoming, (SELECT count(*) FROM venues) AS venues",
	[now],
);
const row = check.rows[0];
console.log(`Turso now: ${JSON.stringify(row)}`);
local.close();
turso.close();

/**
 * Ask Vercel to rebuild, which is what turns the new rows into pages: the
 * agenda snapshot, `/evento/<slug>` pages, OG cards and the sitemap are all
 * written at build time. Runs only after the batch above has committed, so a
 * hook failure can never leave a half-published database.
 */
async function triggerRedeploy(hookUrl: string): Promise<boolean> {
	// The hook URL is a credential (anyone holding it can trigger builds), so
	// the log names only the host.
	let host: string;
	try {
		host = new URL(hookUrl).host;
	} catch {
		console.error(
			"!!! VERCEL_DEPLOY_HOOK_URL is not a valid URL; no redeploy was triggered.",
		);
		return false;
	}
	try {
		const response = await fetch(hookUrl, {
			method: "POST",
			signal: AbortSignal.timeout(15_000),
		});
		const body = await response.text();
		if (!response.ok) {
			console.error(
				`!!! Redeploy hook FAILED: ${host} answered ${response.status} ${response.statusText} ${body.slice(0, 200)}`,
			);
			return false;
		}
		let job = "";
		try {
			const parsed = JSON.parse(body) as {
				job?: { id?: string; state?: string };
			};
			if (parsed.job?.id) {
				job = ` (job ${parsed.job.id}, ${parsed.job.state ?? "queued"})`;
			}
		} catch {
			// Vercel answers JSON; any other 2xx body still means it was accepted.
		}
		console.log(`redeploy requested from ${host}${job}`);
		return true;
	} catch (err) {
		console.error(`!!! Redeploy hook FAILED: could not reach ${host}:`, err);
		return false;
	}
}

const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
if (!hookUrl) {
	console.log(
		"VERCEL_DEPLOY_HOOK_URL not set: Turso is updated, but the site keeps serving its last build until it is redeployed.",
	);
	process.exit(0);
}
if (!(await triggerRedeploy(hookUrl))) {
	console.error(
		"!!! Turso IS published, but the site was NOT redeployed: new events have no pages until the next deploy.",
	);
	process.exit(1);
}
process.exit(0);
