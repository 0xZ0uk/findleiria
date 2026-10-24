import type { SourceId } from "./index";
import { sources } from "./index";
import { runBatch } from "./runner";

/**
 * Scraper runner.
 *
 *   bun run src/scraper/run.ts            → run EVERY source sequentially
 *   bun run src/scraper/run.ts leiriagenda → run one source
 *
 * Per-source failures never stop the batch — one dead source doesn't stop
 * the rest. That includes a source that *throws*: `runSource` records it as
 * a failure (with its `scrape_runs` row) and the batch carries on. The global
 * post-passes (purge, venue merge, reconcile) run once at the end, for one
 * source or all of them. Output: one JSON block per source, a post-pass line,
 * then `ALERT` / `FAILED` lines.
 *
 * Exit code: 0 when every source ran and the post-passes succeeded, 1 when a
 * source failed (see `SourceStatus`) or a post-pass threw, 2 on bad usage.
 */
const arg = process.argv[2];

const sourceIds = Object.keys(sources) as SourceId[];
const toRun: SourceId[] =
	arg == null || arg === "all" || arg === "--all"
		? sourceIds
		: [arg as SourceId];

if (toRun.length === 0 || toRun.some((id) => !(id in sources))) {
	console.error(
		`Unknown source "${arg ?? ""}". Known sources: all, ${sourceIds.join(", ")}`,
	);
	process.exit(2);
}

const report = await runBatch(toRun.map((id) => [id, sources[id]] as const));
process.exit(report.ok ? 0 : 1);
