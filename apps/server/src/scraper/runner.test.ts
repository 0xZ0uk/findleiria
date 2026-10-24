import { describe, expect, test } from "bun:test";

import { errorMessage } from "./errors";
import type { IngestResult, ScrapeMeta } from "./ingest";
import { runSource } from "./runner";
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
			itemsFailed: meta.failures,
			error: meta.firstError,
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
