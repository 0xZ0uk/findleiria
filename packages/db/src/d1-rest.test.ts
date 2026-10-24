import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createD1ReadDb } from "./d1-read";
import {
	createD1Query,
	createD1Raw,
	D1Error,
	isRetryableStatus,
	parseRetryAfter,
	READ_BACKOFF_BASE_MS,
	READ_MAX_RETRIES,
	READ_MAX_RETRY_WAIT_MS,
	retryDelayMs,
} from "./d1-rest";

const OK_RAW = JSON.stringify({
	success: true,
	errors: [],
	result: [
		{
			results: { columns: ["n"], rows: [[1]] },
			success: true,
			meta: {},
		},
	],
});
const OK_QUERY = JSON.stringify({
	success: true,
	errors: [],
	result: [{ results: [{ n: 1 }], success: true, meta: {} }],
});

/** A fake fetch that answers from a script and records every call. */
function scripted(...answers: (Response | Error)[]) {
	const calls: { url: string; body: string }[] = [];
	const queue = [...answers];
	const fake = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: String(init?.body) });
		const next = queue.shift();
		if (!next) throw new Error("fake fetch: no more scripted answers");
		if (next instanceof Error) throw next;
		return next;
	}) as unknown as typeof fetch;
	return { fake, calls };
}

const reply = (
	status: number,
	body: string,
	headers?: Record<string, string>,
) => new Response(body, { status, headers });

function readClient(fake: typeof fetch) {
	const waits: number[] = [];
	const raw = createD1Raw({
		accountId: "acc",
		databaseId: "db",
		token: "tok",
		fetch: fake,
		sleep: async (ms) => void waits.push(ms),
		random: () => 0,
	});
	return { raw, waits };
}

describe("retry helpers", () => {
	test("only 429 and 5xx are retryable", () => {
		for (const status of [429, 500, 502, 503, 504, 599]) {
			expect(isRetryableStatus(status)).toBe(true);
		}
		for (const status of [200, 400, 401, 403, 404, 409, 499]) {
			expect(isRetryableStatus(status)).toBe(false);
		}
	});

	test("Retry-After: seconds, HTTP date, junk", () => {
		expect(parseRetryAfter("7")).toBe(7000);
		expect(parseRetryAfter(" 0 ")).toBe(0);
		const now = Date.parse("2026-10-24T12:00:00Z");
		expect(parseRetryAfter("Sat, 24 Oct 2026 12:00:03 GMT", now)).toBe(3000);
		expect(parseRetryAfter("Sat, 24 Oct 2026 11:00:00 GMT", now)).toBe(0);
		expect(parseRetryAfter("soon")).toBeNull();
		expect(parseRetryAfter("")).toBeNull();
		expect(parseRetryAfter(null)).toBeNull();
	});

	test("backoff doubles, jitter is added, Retry-After raises but is capped", () => {
		const base = READ_BACKOFF_BASE_MS;
		expect(retryDelayMs(0, null, () => 0)).toBe(base);
		expect(retryDelayMs(1, null, () => 0)).toBe(2 * base);
		expect(retryDelayMs(2, null, () => 0)).toBe(4 * base);
		expect(retryDelayMs(0, null, () => 0.5)).toBe(base + base / 2);
		// A hint above the step wins; one below it does not shorten the wait.
		expect(retryDelayMs(0, 5000, () => 0)).toBe(5000);
		expect(retryDelayMs(2, 100, () => 0)).toBe(4 * base);
		expect(retryDelayMs(0, 10 * 60_000, () => 0)).toBe(READ_MAX_RETRY_WAIT_MS);
	});
});

describe("D1 read retries (/raw)", () => {
	test("retries a 429 then a 503 and returns the eventual answer", async () => {
		const { fake, calls } = scripted(
			reply(429, "slow down"),
			reply(503, "<html>"),
			reply(200, OK_RAW),
		);
		const { raw, waits } = readClient(fake);

		const [result] = await raw("select 1");

		expect(result?.rows).toEqual([[1]]);
		expect(calls).toHaveLength(3);
		// Same request every time.
		expect(new Set(calls.map((c) => c.body)).size).toBe(1);
		expect(waits).toEqual([READ_BACKOFF_BASE_MS, 2 * READ_BACKOFF_BASE_MS]);
	});

	test("honours Retry-After", async () => {
		const { fake } = scripted(
			reply(429, "", { "retry-after": "4" }),
			reply(200, OK_RAW),
		);
		const { raw, waits } = readClient(fake);
		await raw("select 1");
		expect(waits).toEqual([4000]);
	});

	test("gives up after READ_MAX_RETRIES retries and reports the last answer", async () => {
		const { fake, calls } = scripted(
			...Array.from({ length: READ_MAX_RETRIES + 1 }, () => reply(500, "boom")),
		);
		const { raw, waits } = readClient(fake);

		await expect(raw("select 1")).rejects.toThrow(D1Error);
		expect(calls).toHaveLength(1 + READ_MAX_RETRIES);
		expect(waits).toHaveLength(READ_MAX_RETRIES);
	});

	test("does not retry other statuses, SQL errors or network failures", async () => {
		for (const answer of [
			reply(
				400,
				JSON.stringify({
					success: false,
					errors: [{ code: 7500, message: "no such table" }],
				}),
			),
			reply(401, "{}"),
			reply(404, "{}"),
			new Error("socket hang up"),
		]) {
			const { fake, calls } = scripted(answer, reply(200, OK_RAW));
			const { raw, waits } = readClient(fake);
			await expect(raw("select 1")).rejects.toThrow(D1Error);
			expect(calls).toHaveLength(1);
			expect(waits).toEqual([]);
		}
	});

	test("the drizzle read db goes through the same retries", async () => {
		const { fake, calls } = scripted(
			reply(502, "bad gateway"),
			reply(200, OK_RAW),
		);
		const waits: number[] = [];
		const db = createD1ReadDb({
			accountId: "acc",
			databaseId: "db",
			token: "tok",
			fetch: fake,
			sleep: async (ms) => void waits.push(ms),
			random: () => 0,
		});
		await db.run(sql`select 1`);
		expect(calls).toHaveLength(2);
		expect(waits).toEqual([READ_BACKOFF_BASE_MS]);
	});
});

describe("D1 writes are never retried (/query)", () => {
	test("a 503 on the publish path fails on the first attempt", async () => {
		const { fake, calls } = scripted(
			reply(503, "unavailable"),
			reply(200, OK_QUERY),
		);
		const query = createD1Query({
			accountId: "acc",
			databaseId: "db",
			token: "tok",
			fetch: fake,
			sleep: async () => {
				throw new Error("a write must not wait for a retry");
			},
		});

		await expect(query("drop table events")).rejects.toThrow(D1Error);
		expect(calls).toHaveLength(1);
	});

	test("a 429 on the publish path fails on the first attempt", async () => {
		const { fake, calls } = scripted(reply(429, "slow"), reply(200, OK_QUERY));
		const query = createD1Query({
			accountId: "acc",
			databaseId: "db",
			token: "tok",
			fetch: fake,
		});
		await expect(query("insert into t values (1)")).rejects.toThrow(D1Error);
		expect(calls).toHaveLength(1);
	});
});
