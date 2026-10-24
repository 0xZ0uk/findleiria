import { describe, expect, test } from "bun:test";
import {
	FETCH_RETRIES,
	type FetchTextDeps,
	fetchTextWith,
	MAX_RETRY_AFTER_MS,
	parseRetryAfter,
	RATE_LIMIT_BACKOFF_MS,
	RETRY_BACKOFF_MS,
} from "./http";

type Step = Response | Error | (() => Response);

function makeDeps(steps: Step[], curlResult: string | Error = "curl-body") {
	const sleeps: number[] = [];
	let calls = 0;
	let curlCalls = 0;
	const deps: FetchTextDeps = {
		fetch: async () => {
			const step = steps[Math.min(calls, steps.length - 1)];
			calls++;
			if (step === undefined) throw new Error("no fetch step scripted");
			if (step instanceof Error) throw step;
			return typeof step === "function" ? step() : step;
		},
		curl: async () => {
			curlCalls++;
			if (curlResult instanceof Error) throw curlResult;
			return curlResult;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	return {
		deps,
		sleeps,
		calls: () => calls,
		curlCalls: () => curlCalls,
	};
}

const ok = (body = "ok") => new Response(body, { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) =>
	new Response("x", { status: code, headers });

describe("fetchTextWith", () => {
	test("returns the body on 200 without sleeping", async () => {
		const t = makeDeps([ok("hello")]);
		expect(await fetchTextWith("http://x", t.deps)).toBe("hello");
		expect(t.calls()).toBe(1);
		expect(t.sleeps).toEqual([]);
	});

	test("retries 5xx with linear backoff, then succeeds", async () => {
		const t = makeDeps([status(503), status(500), ok("fine")]);
		expect(await fetchTextWith("http://x", t.deps)).toBe("fine");
		expect(t.calls()).toBe(3);
		expect(t.sleeps).toEqual([RETRY_BACKOFF_MS, RETRY_BACKOFF_MS * 2]);
	});

	test("makes exactly FETCH_RETRIES + 1 attempts then throws", async () => {
		const t = makeDeps([status(502)]);
		await expect(fetchTextWith("http://x", t.deps)).rejects.toThrow("HTTP 502");
		expect(t.calls()).toBe(FETCH_RETRIES + 1);
	});

	test("does not retry 404 / 403", async () => {
		for (const code of [403, 404]) {
			const t = makeDeps([status(code), ok()]);
			await expect(fetchTextWith("http://x", t.deps)).rejects.toThrow(
				`HTTP ${code}`,
			);
			expect(t.calls()).toBe(1);
		}
	});

	test("retries 408", async () => {
		const t = makeDeps([status(408), ok("late")]);
		expect(await fetchTextWith("http://x", t.deps)).toBe("late");
		expect(t.calls()).toBe(2);
	});

	test("429 honours Retry-After seconds", async () => {
		const t = makeDeps([status(429, { "retry-after": "7" }), ok("after")]);
		expect(await fetchTextWith("http://x", t.deps)).toBe("after");
		expect(t.sleeps).toEqual([7000]);
	});

	test("429 Retry-After is capped", async () => {
		const t = makeDeps([status(429, { "retry-after": "99999" }), ok()]);
		await fetchTextWith("http://x", t.deps);
		expect(t.sleeps).toEqual([MAX_RETRY_AFTER_MS]);
	});

	test("429 without Retry-After uses the long cooldown", async () => {
		const t = makeDeps([status(429), ok()]);
		await fetchTextWith("http://x", t.deps);
		expect(t.sleeps).toEqual([RATE_LIMIT_BACKOFF_MS]);
	});

	test("retries network errors", async () => {
		const t = makeDeps([new Error("ECONNRESET"), ok("back")]);
		expect(await fetchTextWith("http://x", t.deps)).toBe("back");
		expect(t.calls()).toBe(2);
	});

	test("body-read errors are retried (res.text() is awaited)", async () => {
		const broken = () =>
			({
				ok: true,
				status: 200,
				headers: new Headers(),
				text: () => Promise.reject(new Error("body stream died")),
			}) as unknown as Response;
		const t = makeDeps([broken, ok("second")]);
		expect(await fetchTextWith("http://x", t.deps)).toBe("second");
		expect(t.calls()).toBe(2);
	});

	test("malformed-response falls back to curl once", async () => {
		const t = makeDeps([new Error("Malformed_HTTP_Response")], "from-curl");
		expect(await fetchTextWith("http://x", t.deps)).toBe("from-curl");
		expect(t.curlCalls()).toBe(1);
		expect(t.calls()).toBe(1);
	});

	test("curl fallback failure goes through the retry loop", async () => {
		const t = makeDeps(
			[new Error("Malformed_HTTP_Response")],
			new Error("curl exit 22"),
		);
		await expect(fetchTextWith("http://x", t.deps)).rejects.toThrow(
			"curl exit 22",
		);
		expect(t.calls()).toBe(FETCH_RETRIES + 1);
	});
});

describe("parseRetryAfter", () => {
	test("seconds, date, garbage, absent", () => {
		expect(parseRetryAfter("5")).toBe(5000);
		expect(parseRetryAfter(null)).toBeNull();
		expect(parseRetryAfter("soon")).toBeNull();
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10000);
		expect(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now)).toBe(0);
	});
});
