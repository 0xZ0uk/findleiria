import { errorMessage } from "./errors";
import { type IngestResult, ingest, type ScrapeMeta } from "./ingest";
import type { RawEvent } from "./types";

/** What a source's `scrape()` returns. */
export interface ScrapeOutcome {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
}

/** One source's line in the run report. */
export interface SourceRun {
	source: string;
	elapsedMs: number;
	found: number;
	new: number;
	updated: number;
	skippedPast: number;
	purged: number;
	failed: number;
	error: string | null;
	runId: number | null;
}

export type IngestFn = (
	events: RawEvent[],
	source: string,
	meta: ScrapeMeta,
) => Promise<IngestResult>;

/**
 * Scrape + ingest ONE source, turning any throw into a recorded failure.
 *
 * `run.ts` drives every source of the district from here in a single process,
 * so an exception escaping a source used to abort the whole batch: the sources
 * after it were never scraped, and the throwing source got no `scrape_runs`
 * row at all (the batch died before `ingest`). Sources are independent, so a
 * dead one is data to report, not an exit condition.
 *
 * `ingestFn` is injectable so the failure path is testable without a database.
 */
export async function runSource(
	id: string,
	scrape: () => Promise<ScrapeOutcome>,
	ingestFn: IngestFn = ingest,
): Promise<SourceRun> {
	const startedAt = Date.now();
	let events: RawEvent[] = [];
	let failures = 0;
	let firstError: string | null = null;
	let thrown: string | null = null;

	try {
		({ events, failures, firstError } = await scrape());
	} catch (err) {
		thrown = errorMessage(err);
	}

	// A thrown scrape counts as one failure, so a run row is never "ok" with
	// zero items when in fact the source never produced anything.
	const meta: ScrapeMeta = {
		found: events.length + failures + (thrown ? 1 : 0),
		failures: failures + (thrown ? 1 : 0),
		firstError: firstError ?? thrown,
	};

	const head = {
		source: id,
		found: meta.found,
		failed: meta.failures,
		error: meta.firstError,
	};

	try {
		const result = await ingestFn(events, id, meta);
		return {
			...head,
			elapsedMs: Date.now() - startedAt,
			new: result.itemsNew,
			updated: result.itemsUpdated,
			skippedPast: result.itemsSkippedPast,
			purged: result.itemsPurged,
			runId: result.runId,
		};
	} catch (err) {
		// A broken write is a failed source too — honest about it, and the
		// remaining sources still get their turn.
		return {
			...head,
			elapsedMs: Date.now() - startedAt,
			new: 0,
			updated: 0,
			skippedPast: 0,
			purged: 0,
			runId: null,
			error: `ingest failed: ${errorMessage(err)}`,
		};
	}
}
