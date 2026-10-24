/**
 * Mirror the local SQLite DB into Cloudflare D1 (`findleiria-events`), the
 * database the deployed site's build reads.
 *
 * Nothing else publishes `local.db`: the scraper writes local SQLite, the site
 * reads D1, and until this runs the two drift apart (the site keeps serving
 * an older copy of the district — that is why the calendar once showed 211
 * events after a run that had ingested 434). Full-table mirror; counts are
 * printed on both sides.
 *
 * Atomicity (a half-published DB must be impossible). D1's REST API has no
 * BEGIN/COMMIT, and one request is capped (100 KB per statement, 30 s per
 * request), so the data cannot go in a single request. Instead
 * (`d1-mirror.ts`): the rows are loaded into `<table>_next` staging tables
 * over as many requests as needed — the site never reads those — and then
 * ONE `/query` request asserts the staging counts, drops the live tables,
 * renames the staging tables into place and rebuilds the indexes. That one
 * request commits whole or not at all:
 *   - REST `/query`: "Supports multiple statements, joined by semicolons,
 *     which will be executed as a batch" (API reference, D1 › Database ›
 *     Query), and "Batched statements are SQL transactions … If a statement
 *     in the sequence fails … it aborts or rolls back the entire sequence"
 *     (D1 Worker API, batch()).
 *   - `wrangler d1 migrations apply --remote` sends each migration plus its
 *     `INSERT INTO d1_migrations` as one `/query` `{ sql }` request, exactly
 *     this shape, and documents "If applying a migration results in an
 *     error, this migration will be rolled back".
 * A failure before the swap leaves the live tables untouched (the next run
 * drops the leftover staging tables); the swap's own count assertions catch
 * a staging load that went missing.
 *
 * Write budget: D1 bills rows written (index entries included). Staging
 * writes every row once, the swap rebuilds every index entry, and dropping
 * `events` costs one write per row (the empty `event_aliases` table holds an
 * ON DELETE CASCADE foreign key to it); the other drops are free. Measured on
 * local D1 with 1,500 events / 2,250 sources / 1,000 runs / 60 venues: ~17.9k
 * rows written per publish, against ~20k for the old DELETE-all + INSERT-all,
 * i.e. ~0.55M a month of Workers Paid's 50M included. A diff-based mirror
 * would save cents a month, so it is not worth its complexity. The run prints
 * D1's own `rows_written`.
 *
 * The site does not read D1 at runtime: its build turns D1 into a static
 * JSON snapshot. So a publish only reaches readers once the site rebuilds,
 * and when `DEPLOY_HOOK_URL` is set this run asks for that rebuild
 * after the swap has committed. A failed hook exits non-zero (the data is
 * safe in D1; the site is just still serving the previous build).
 *
 *   bun run db:publish                    # from packages/db, uses the repo .env
 *
 * The daily job (`pnpm --filter server daily`) runs this after the scrape.
 * Schema: every local column of the mirrored tables is published, so D1 must
 * be migrated as far as local.db (`db:migrate:remote`, see the README); a
 * missing table, column or index fails the publish before anything is
 * written.
 *
 * Retention: scrape_runs older than 90 days are pruned from local.db first
 * (each source keeps its latest run), and the mirror carries that to D1.
 */
import { Database } from "bun:sqlite";

import { MIGRATE_HINT, mirrorToD1, POST_PUBLISH_QUERY } from "./d1-mirror";
import { createD1Query } from "./d1-rest";
import {
	parseDeployHookResponse,
	pruneScrapeRuns,
	SCRAPE_RUNS_RETENTION_DAYS,
} from "./publish-lib";

const databaseUrl = process.env.DATABASE_URL ?? "";
const localPath = databaseUrl.replace(/^file:/, "");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.EVENTS_D1_ID;
// The build's D1 token is read-only; publishing needs the D1-edit one.
const token = process.env.D1_RW_API_TOKEN;

if (localPath === "" || localPath === databaseUrl) {
	console.error(
		"db:publish needs DATABASE_URL as a local file URL (file:…/local.db).",
	);
	process.exit(1);
}
if (!accountId || !databaseId || !token) {
	console.error(
		"db:publish needs CLOUDFLARE_ACCOUNT_ID, EVENTS_D1_ID and D1_RW_API_TOKEN.",
	);
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

const local = new Database(localPath, { readonly: true, safeIntegers: true });
const d1 = createD1Query({ accountId, databaseId, token });

const started = Date.now();
let mirrored: Awaited<ReturnType<typeof mirrorToD1>>;
try {
	mirrored = await mirrorToD1(local, d1);
} catch (err) {
	console.error(
		`!!! D1 NOT published (the live tables are unchanged): ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
} finally {
	local.close();
}
const published = [...mirrored.counts.values()].reduce((a, b) => a + b, 0);
console.log(
	`published ${published} rows to D1 in ${Date.now() - started}ms (${mirrored.requests} requests, ${mirrored.rowsWritten} rows written, ${mirrored.swapRowsWritten} of them in the swap)`,
);

// Read back what the site will see; a mismatch means something other than
// this run wrote to D1 in between, which is worth an alarm.
let countsMatch = false;
try {
	const row = (await d1(POST_PUBLISH_QUERY(Date.now() / 1000)))[0]
		?.results[0] as Record<string, number> | undefined;
	console.log(`D1 now: ${JSON.stringify(row)}`);
	countsMatch =
		row !== undefined &&
		row.total === mirrored.counts.get("events") &&
		row.venues === mirrored.counts.get("venues") &&
		row.event_sources === mirrored.counts.get("event_sources") &&
		row.scrape_runs === mirrored.counts.get("scrape_runs");
	if (!countsMatch) {
		console.error("!!! D1 counts do not match what was published.");
	}
} catch (err) {
	console.error("!!! could not read D1 back after publishing:", err);
}
if (!countsMatch) {
	console.error(`If D1's schema looks wrong: ${MIGRATE_HINT}`);
}

/**
 * Ask Workers Builds to rebuild (a deploy hook), which is what turns the new rows into pages: the
 * agenda snapshot, `/evento/<slug>` pages, OG cards and the sitemap are all
 * written at build time. Runs only after the swap has committed, so a hook
 * failure can never leave a half-published database.
 */
async function triggerRedeploy(hookUrl: string): Promise<boolean> {
	// The hook URL is a credential (anyone holding it can trigger builds), so
	// the log names only the host.
	let host: string;
	try {
		host = new URL(hookUrl).host;
	} catch {
		console.error(
			"!!! DEPLOY_HOOK_URL is not a valid URL; no redeploy was triggered.",
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
		// Workers Builds answers `{ result: { build_uuid, … } }`; any other 2xx
		// body still means it was accepted.
		const { buildUuid, alreadyQueued } = parseDeployHookResponse(body);
		const build = buildUuid
			? ` (build ${buildUuid}${alreadyQueued ? ", already queued" : ""})`
			: "";
		console.log(`redeploy requested from ${host}${build}`);
		return true;
	} catch (err) {
		console.error(`!!! Redeploy hook FAILED: could not reach ${host}:`, err);
		return false;
	}
}

const hookUrl = process.env.DEPLOY_HOOK_URL;
if (!hookUrl) {
	console.log(
		"DEPLOY_HOOK_URL not set: D1 is updated, but the site keeps serving its last build until it is redeployed.",
	);
	process.exit(countsMatch ? 0 : 1);
}
if (!(await triggerRedeploy(hookUrl))) {
	console.error(
		"!!! D1 IS published, but the site was NOT redeployed: new events have no pages until the next deploy.",
	);
	process.exit(1);
}
process.exit(countsMatch ? 0 : 1);
