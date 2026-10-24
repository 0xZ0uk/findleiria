import { describe, expect, test } from "bun:test";

import { publishDecision } from "./daily";
import { errorMessage } from "./errors";
import { listsFully, SOURCE_LISTING, sources } from "./index";
import type { IngestResult, PostPassOutcome, ScrapeMeta } from "./ingest";
import {
	alertFor,
	type BatchReport,
	runBatch,
	runSource,
	type ScrapeOutcome,
	type SourceStatus,
} from "./runner";
import type { RawEvent } from "./types";

const rawEvent = (slug: string) =>
	({
		slug,
		title: slug,
		url: `https://example.test/${slug}`,
		startAt: 1_800_000_000,
		endAt: 1_800_000_000,
		venueName: "Sala",
		city: "Leiria",
		dateText: null,
		imageUrl: null,
		description: null,
		categories: [],
		sourceId: "test",
	}) as unknown as RawEvent;

const stubIngest =
	(captured: ScrapeMeta[], result: Partial<IngestResult> = {}) =>
	async (
		_events: RawEvent[],
		_source: string,
		meta: ScrapeMeta,
	): Promise<IngestResult> => {
		captured.push(meta);
		return {
			itemsFound: meta.found,
			itemsNew: 0,
			itemsUpdated: 0,
			itemsSkippedPast: 0,
			itemsPurged: 0,
			itemsPruned: 0,
			itemsFailed: meta.failures,
			itemsWriteFailed: 0,
			error: meta.firstError,
			warnings: null,
			runId: 7,
			...result,
		};
	};

describe("errorMessage", () => {
	test("reads Errors, strings and anything else without throwing", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage({ code: 403 })).toBe('{"code":403}');
		expect(errorMessage(null)).toBe("null");
	});

	test("a drizzle 'Failed query' wrapper yields the driver's message", () => {
		const wrapped = new Error(
			"Failed query: insert into x values (?)\nparams: 1",
			{
				cause: new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed"),
			},
		);
		expect(errorMessage(wrapped)).toBe(
			"SQLITE_CONSTRAINT: NOT NULL constraint failed",
		);
	});
});

describe("runSource (a dead source must not kill the batch)", () => {
	test("a source that THROWS is recorded as a failure, not an exit", async () => {
		const captured: ScrapeMeta[] = [];
		const run = await runSource(
			"municipal",
			async () => {
				throw new Error("Invalid Europe/Lisbon datetime: 2023-2-29 0:0");
			},
			stubIngest(captured),
		);

		// The run row still happens, carrying the reason.
		expect(captured.length).toBe(1);
		expect(captured[0]?.failures).toBe(1);
		expect(captured[0]?.firstError).toContain("2023-2-29");
		expect(captured[0]?.found).toBe(1);

		expect(run.source).toBe("municipal");
		expect(run.failed).toBe(1);
		expect(run.error).toContain("2023-2-29");
		expect(run.runId).toBe(7);
	});

	test("a source's own partial failures survive into the run record", async () => {
		const captured: ScrapeMeta[] = [];
		const run = await runSource(
			"caldas",
			async () => ({
				events: [rawEvent("a"), rawEvent("b")],
				failures: 1,
				firstError: "https://www.mcr.pt/agenda?page=3: HTTP 403",
			}),
			stubIngest(captured, { itemsNew: 2 }),
		);

		expect(captured[0]).toEqual({
			found: 3,
			failures: 1,
			firstError: "https://www.mcr.pt/agenda?page=3: HTTP 403",
			fullListing: false,
			discovered: null,
			pagesFetched: null,
		});
		expect(run.found).toBe(3);
		expect(run.new).toBe(2);
		expect(run.failed).toBe(1);
		expect(run.error).toContain("page=3");
	});

	test("a broken ingest write is a failed source too, never a crash", async () => {
		const run = await runSource(
			"obidos",
			async () => ({ events: [rawEvent("x")], failures: 0, firstError: null }),
			async () => {
				throw new Error("SQLITE_BUSY: database is locked");
			},
		);

		expect(run.error).toContain("ingest failed");
		expect(run.error).toContain("SQLITE_BUSY");
		expect(run.new).toBe(0);
		expect(run.runId).toBeNull();
	});

	test("the batch continues: a throwing source does not cancel the next one", async () => {
		const ids = ["municipal", "obidos"] as const;
		const runs = [];
		for (const id of ids) {
			runs.push(
				await runSource(
					id,
					async () => {
						if (id === "municipal") {
							throw new Error("network down");
						}
						return { events: [rawEvent("y")], failures: 0, firstError: null };
					},
					stubIngest([]),
				),
			);
		}

		expect(runs.map((r) => r.source)).toEqual(["municipal", "obidos"]);
		expect(runs[0]?.failed).toBe(1);
		expect(runs[1]?.error).toBeNull();
		expect(runs[1]?.found).toBe(1);
	});
});

describe("source listing metadata (C5 prune eligibility)", () => {
	test("every registered source is classified explicitly", () => {
		expect(Object.keys(SOURCE_LISTING).sort()).toEqual(
			Object.keys(sources).sort(),
		);
	});

	test("the incremental (never pruned) set is pinned", () => {
		const incremental = Object.entries(SOURCE_LISTING)
			.filter(([, listing]) => listing === "incremental")
			.map(([id]) => id)
			.sort();
		expect(incremental).toEqual([
			"caldas",
			"cisterfestas",
			"festasearraiais",
			"municipal",
			"nocartaz",
			"obidos",
			"regiaoleiria",
		]);
	});

	test("manual and unknown sources never list fully", () => {
		expect(listsFully("manual")).toBe(false);
		expect(listsFully("some-new-source")).toBe(false);
		expect(listsFully("toString")).toBe(false);
		expect(listsFully("leiriagenda")).toBe(true);
	});

	const ok = async () => ({
		events: [rawEvent("a")],
		failures: 0,
		firstError: null,
	});

	test("a clean run of a full-listing source may prune", async () => {
		const captured: ScrapeMeta[] = [];
		await runSource("leiriagenda", ok, stubIngest(captured));
		expect(captured[0]?.fullListing).toBe(true);
	});

	test("an incremental source never may, even on a clean run", async () => {
		const captured: ScrapeMeta[] = [];
		await runSource("caldas", ok, stubIngest(captured));
		expect(captured[0]?.fullListing).toBe(false);
	});

	test("a full-listing source with any failure or a throw may not", async () => {
		const captured: ScrapeMeta[] = [];
		await runSource(
			"leiriagenda",
			async () => ({ events: [rawEvent("a")], failures: 1, firstError: "x" }),
			stubIngest(captured),
		);
		await runSource(
			"leiriagenda",
			async () => {
				throw new Error("down");
			},
			stubIngest(captured),
		);
		expect(captured.map((m) => m.fullListing)).toEqual([false, false]);
	});
});

describe("C7 — a source's state is committed only after its ingest", () => {
	const withCommit =
		(commits: string[], over: Partial<ScrapeOutcome> = {}) =>
		async (): Promise<ScrapeOutcome> => ({
			events: [rawEvent("a")],
			failures: 0,
			firstError: null,
			commit: () => {
				commits.push("saved");
			},
			...over,
		});

	test("ingest succeeded: committed", async () => {
		const commits: string[] = [];
		const run = await runSource("caldas", withCommit(commits), stubIngest([]));
		expect(commits).toEqual(["saved"]);
		expect(run.stateCommitted).toBe(true);
	});

	test("ingest threw: state unchanged, every item retried next run", async () => {
		const commits: string[] = [];
		const run = await runSource("caldas", withCommit(commits), async () => {
			throw new Error("SQLITE_BUSY");
		});
		expect(commits).toEqual([]);
		expect(run.stateCommitted).toBe(false);
		expect(run.status).toBe("failed");
	});

	test("a write that failed inside ingest: state unchanged", async () => {
		const commits: string[] = [];
		const run = await runSource(
			"caldas",
			withCommit(commits),
			stubIngest([], { itemsWriteFailed: 1, itemsFailed: 1, error: "boom" }),
		);
		expect(commits).toEqual([]);
		expect(run.stateCommitted).toBe(false);
		expect(run.status).toBe("partial");
	});

	test("a commit that throws is a warning, not a failed run", async () => {
		const run = await runSource(
			"caldas",
			withCommit([], {
				commit: () => {
					throw new Error("EACCES");
				},
			}),
			stubIngest([]),
		);
		expect(run.status).toBe("ok");
		expect(run.warnings).toContain("state save failed: EACCES");
	});
});

describe("C10 — run status, counts and the empty-listing ALERT", () => {
	test("discovered and pagesFetched reach the run record and the report", async () => {
		const captured: ScrapeMeta[] = [];
		const run = await runSource(
			"municipal",
			async () => ({
				events: [],
				failures: 0,
				firstError: null,
				discovered: 163,
				pagesFetched: 156,
			}),
			stubIngest(captured),
		);
		expect(captured[0]?.discovered).toBe(163);
		expect(captured[0]?.pagesFetched).toBe(156);
		expect(run.discovered).toBe(163);
		expect(run.status).toBe("ok");
		// An incremental source with nothing new is a quiet day.
		expect(alertFor(run)).toBeNull();
	});

	test("an incremental source failing one page, nothing new, listing intact: partial", async () => {
		const run = await runSource(
			"municipal",
			async () => ({
				events: [],
				failures: 1,
				firstError: "page 31: HTTP 403",
				discovered: 120,
			}),
			stubIngest([]),
		);
		expect(run.status).toBe("partial");
	});

	test("an error with an empty listing is a failed source", async () => {
		const run = await runSource(
			"nocartaz",
			async () => ({
				events: [],
				failures: 1,
				firstError: "hub: HTTP 503",
				discovered: 0,
			}),
			stubIngest([]),
		);
		expect(run.status).toBe("failed");
		// Already loud as a failure: no second ALERT line.
		expect(alertFor(run)).toBeNull();
	});

	test("an empty listing with no error raises the ALERT", async () => {
		const quiet = await runSource(
			"leiriagenda",
			async () => ({ events: [], failures: 0, firstError: null }),
			stubIngest([]),
		);
		expect(alertFor(quiet)).toContain("ALERT leiriagenda");
		const incremental = await runSource(
			"obidos",
			async () => ({
				events: [],
				failures: 0,
				firstError: null,
				discovered: 0,
			}),
			stubIngest([]),
		);
		expect(alertFor(incremental)).toContain("ALERT obidos");
	});
});

describe("runBatch — the global passes run once per batch (C8)", () => {
	const passes = (errors: string[] = []): PostPassOutcome => ({
		purged: 2,
		venuesMerged: 1,
		groupsReconciled: 0,
		errors,
		timingsMs: { purge: 1, venueMerge: 1, reconcile: 1 },
	});

	test("three sources, one post-pass run, its outcome recorded on every run row", async () => {
		let postPassRuns = 0;
		const recorded: number[][] = [];
		let next = 1;
		const report = await runBatch(
			["leiriagenda", "bol", "caldas"].map(
				(id) =>
					[
						id,
						async () => ({
							events: [rawEvent(id)],
							failures: 0,
							firstError: null,
						}),
					] as const,
			),
			{
				ingestFn: async (events, source, meta) => ({
					...(await stubIngest([])(events, source, meta)),
					runId: next++,
				}),
				postPasses: async () => {
					postPassRuns++;
					return passes(["reconcile failed: boom"]);
				},
				recordPostPasses: async (ids) => {
					recorded.push([...ids]);
				},
				log: () => {},
			},
		);
		expect(postPassRuns).toBe(1);
		expect(recorded).toEqual([[1, 2, 3]]);
		expect(report.ok).toBe(false);
		expect(report.failedSources).toEqual([]);
	});

	test("a failed source fails the batch but the others still run", async () => {
		const lines: string[] = [];
		const report = await runBatch(
			[
				[
					"municipal",
					async () => {
						throw new Error("network down");
					},
				],
				[
					"bol",
					async () => ({
						events: [rawEvent("b")],
						failures: 0,
						firstError: null,
					}),
				],
			],
			{
				ingestFn: stubIngest([]),
				postPasses: async () => passes(),
				recordPostPasses: async () => {},
				log: (l) => lines.push(l),
			},
		);
		expect(report.runs.map((r) => r.status)).toEqual(["failed", "ok"]);
		expect(report.failedSources).toEqual(["municipal"]);
		expect(report.ok).toBe(false);
		expect(lines.some((l) => l.startsWith("FAILED municipal"))).toBe(true);
	});
});

describe("daily publish policy", () => {
	const report = (statuses: SourceStatus[], postErrors: string[] = []) =>
		({
			runs: statuses.map((status, i) => ({ source: `s${i}`, status })),
			failedSources: statuses.flatMap((s, i) =>
				s === "failed" ? [`s${i}`] : [],
			),
			postPasses: { errors: postErrors },
		}) as unknown as BatchReport;

	test("one failed source still publishes the rest", () => {
		expect(publishDecision(report(["ok", "failed", "partial"])).publish).toBe(
			true,
		);
	});

	test("a hard failure does not publish", () => {
		expect(publishDecision(report(["failed", "failed", "ok"])).publish).toBe(
			false,
		);
		expect(
			publishDecision(report(["ok", "ok"], ["purge failed: x"])).publish,
		).toBe(false);
		expect(publishDecision(report([])).publish).toBe(false);
	});
});
