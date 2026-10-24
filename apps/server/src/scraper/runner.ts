import { errorMessage } from "./errors";
import { listsFully } from "./index";
import {
	type IngestResult,
	ingestSource,
	type PostPassOutcome,
	recordPostPasses,
	runPostPasses,
	type ScrapeMeta,
} from "./ingest";
import type { RawEvent } from "./types";

/** What a source's `scrape()` returns. */
export interface ScrapeOutcome {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	/** Pages fetched (listing + details), when the source counts them. */
	pagesFetched?: number;
	/**
	 * Items the source's LISTING showed, pre-gate and including ones already
	 * seen by an incremental source. 0 means the listing itself came back
	 * empty — for a source that always lists something, a broken parser.
	 */
	discovered?: number;
	/**
	 * The source's state update (incremental "seen" set, watermark, detail
	 * cache), deferred (C7). The runner applies it only after the ingest of
	 * `events` committed with no failed write, so an item whose ingest failed
	 * is scraped again next run. Sources only fold into it the items they
	 * emitted or deliberately skipped (out of district, already over), never
	 * a failed fetch or parse.
	 */
	commit?: () => void;
}

/**
 * How a source's run went:
 *  - `ok`: scraped and written, no failures;
 *  - `partial`: written, but some items failed (one 404 detail page, one
 *    card whose markup broke) — data, not an outage;
 *  - `failed`: nothing usable — the scrape threw, the ingest threw, or the
 *    source reported an error and its listing came back empty (no
 *    `discovered` items; no events for a source that does not count them).
 */
export type SourceStatus = "ok" | "partial" | "failed";

/** One source's line in the run report. */
export interface SourceRun {
	source: string;
	status: SourceStatus;
	elapsedMs: number;
	scrapeMs: number;
	ingestMs: number;
	found: number;
	/** Items the listing showed (see ScrapeOutcome.discovered); null when unreported. */
	discovered: number | null;
	pagesFetched: number | null;
	new: number;
	updated: number;
	skippedPast: number;
	/** Rows the source stopped listing, pruned (full-listing sources only). */
	pruned: number;
	failed: number;
	error: string | null;
	warnings: string | null;
	/** Whether the source's deferred state update was applied (C7). */
	stateCommitted: boolean;
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
 * The global post-passes are not run here (see `runBatch`). `ingestFn` is
 * injectable so the failure path is testable without a database.
 */
export async function runSource(
	id: string,
	scrape: () => Promise<ScrapeOutcome>,
	ingestFn: IngestFn = ingestSource,
): Promise<SourceRun> {
	const startedAt = Date.now();
	let outcome: ScrapeOutcome = { events: [], failures: 0, firstError: null };
	let thrown: string | null = null;

	try {
		outcome = await scrape();
	} catch (err) {
		thrown = errorMessage(err);
	}
	const { events, failures, firstError } = outcome;
	const scrapeMs = Date.now() - startedAt;

	// A thrown scrape counts as one failure, so a run row is never "ok" with
	// zero items when in fact the source never produced anything.
	const meta: ScrapeMeta = {
		found: events.length + failures + (thrown ? 1 : 0),
		failures: failures + (thrown ? 1 : 0),
		firstError: firstError ?? thrown,
		// Pruning trusts the run to be the source's whole listing: only a
		// full-listing source, and only when nothing failed or threw.
		fullListing: listsFully(id) && failures === 0 && thrown === null,
		discovered: outcome.discovered ?? null,
		pagesFetched: outcome.pagesFetched ?? null,
	};

	const head = {
		source: id,
		scrapeMs,
		found: meta.found,
		discovered: meta.discovered ?? null,
		pagesFetched: meta.pagesFetched ?? null,
		failed: meta.failures,
		error: meta.firstError,
	};

	const ingestStarted = Date.now();
	let result: IngestResult;
	try {
		result = await ingestFn(events, id, meta);
	} catch (err) {
		// A broken write is a failed source too — honest about it, and the
		// remaining sources still get their turn. The state is NOT committed:
		// every item is scraped again next run.
		return {
			...head,
			status: "failed",
			elapsedMs: Date.now() - startedAt,
			ingestMs: Date.now() - ingestStarted,
			new: 0,
			updated: 0,
			skippedPast: 0,
			pruned: 0,
			runId: null,
			error: `ingest failed: ${errorMessage(err)}`,
			warnings: null,
			stateCommitted: false,
		};
	}
	const ingestMs = Date.now() - ingestStarted;

	// C7: the state moves only once its items are safely in the database. A
	// failed write leaves it as it was, so that item is retried next run (the
	// fingerprint makes re-ingesting the others a no-op).
	let warnings = result.warnings;
	let stateCommitted = false;
	if (outcome.commit && thrown === null && result.itemsWriteFailed === 0) {
		try {
			outcome.commit();
			stateCommitted = true;
		} catch (err) {
			const note = `state save failed: ${errorMessage(err)}`;
			warnings = warnings ? `${warnings}; ${note}` : note;
		}
	}

	// An incremental source in steady state emits nothing new, so "no events"
	// alone is not an outage; nothing LISTED plus an error is.
	const listed = outcome.discovered ?? events.length;
	const status: SourceStatus =
		thrown !== null || (result.error != null && listed === 0)
			? "failed"
			: result.itemsFailed > 0 || result.error != null
				? "partial"
				: "ok";

	return {
		...head,
		status,
		elapsedMs: Date.now() - startedAt,
		ingestMs,
		new: result.itemsNew,
		updated: result.itemsUpdated,
		skippedPast: result.itemsSkippedPast,
		pruned: result.itemsPruned,
		failed: result.itemsFailed,
		error: result.error,
		warnings,
		stateCommitted,
		runId: result.runId,
	};
}

/**
 * The broken-parser alarm (C10): a source whose LISTING came back empty.
 * Only the listing count says that — an incremental source finding 0 NEW
 * items is a quiet day, but every source here reports its listing, seen items
 * included, as `discovered`. A source that reports no `discovered` is judged
 * on what it found. A failed source is already loud; no second line for it.
 */
export function alertFor(run: SourceRun): string | null {
	if (run.status === "failed") return null;
	const listed = run.discovered ?? run.found;
	if (listed > 0) return null;
	return `ALERT ${run.source}: listing returned 0 items (pages fetched: ${run.pagesFetched ?? "?"}) — broken parser or blocked, not a quiet day`;
}

export interface BatchReport {
	runs: SourceRun[];
	postPasses: PostPassOutcome;
	alerts: string[];
	/** Sources whose run status is `failed`. */
	failedSources: string[];
	/** Any source failed or a post-pass failed: the process exits non-zero. */
	ok: boolean;
	elapsedMs: number;
}

export interface BatchDeps {
	ingestFn?: IngestFn;
	postPasses?: () => Promise<PostPassOutcome>;
	recordPostPasses?: (
		runIds: readonly number[],
		outcome: PostPassOutcome,
	) => Promise<void>;
	log?: (line: string) => void;
}

/**
 * Run a batch of sources, then the global post-passes ONCE (C8), whatever the
 * batch size. Sources run strictly one after the other (one writer). Each
 * source's JSON line is logged as it finishes, then the post-pass timings,
 * then any ALERT lines.
 */
export async function runBatch(
	sources: readonly (readonly [string, () => Promise<ScrapeOutcome>])[],
	deps: BatchDeps = {},
): Promise<BatchReport> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const started = Date.now();
	const runs: SourceRun[] = [];
	for (const [id, scrape] of sources) {
		const run = await runSource(id, scrape, deps.ingestFn);
		runs.push(run);
		log(JSON.stringify(run, null, 2));
	}

	const postPasses = await (deps.postPasses ?? runPostPasses)();
	const runIds = runs.flatMap((r) => (r.runId == null ? [] : [r.runId]));
	try {
		await (deps.recordPostPasses ?? recordPostPasses)(runIds, postPasses);
	} catch (err) {
		postPasses.errors.push(
			`recording post-passes failed: ${errorMessage(err)}`,
		);
	}
	log(
		JSON.stringify({
			postPasses: {
				purged: postPasses.purged,
				venuesMerged: postPasses.venuesMerged,
				groupsReconciled: postPasses.groupsReconciled,
				timingsMs: postPasses.timingsMs,
				errors: postPasses.errors,
			},
		}),
	);

	const alerts = runs.flatMap((r) => alertFor(r) ?? []);
	for (const alert of alerts) log(alert);
	const failedSources = runs
		.filter((r) => r.status === "failed")
		.map((r) => r.source);
	for (const source of failedSources) {
		const run = runs.find((r) => r.source === source);
		log(`FAILED ${source}: ${run?.error ?? "unknown error"}`);
	}
	for (const error of postPasses.errors) log(`FAILED post-pass: ${error}`);

	return {
		runs,
		postPasses,
		alerts,
		failedSources,
		ok: failedSources.length === 0 && postPasses.errors.length === 0,
		elapsedMs: Date.now() - started,
	};
}
