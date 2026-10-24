import { describe, expect, test } from "bun:test";

import { createFetchGate } from "./fetch-gate";

function setup(
	maxRequests: number,
	fetchText?: (url: string) => Promise<string>,
) {
	const log: string[] = [];
	const gate = createFetchGate({
		fetchText:
			fetchText ??
			(async (url) => {
				log.push(`fetch ${url}`);
				return `body:${url}`;
			}),
		sleep: async (ms) => {
			log.push(`sleep ${ms}`);
		},
		maxRequests,
		delay: () => 7,
	});
	return { gate, log };
}

describe("createFetchGate", () => {
	test("sleeps before each fetch, in order", async () => {
		const { gate, log } = setup(10);
		expect(await gate.fetchPage("a")).toBe("body:a");
		expect(await gate.fetchPage("b")).toBe("body:b");
		expect(log).toEqual(["sleep 7", "fetch a", "sleep 7", "fetch b"]);
		expect(gate.requests()).toBe(2);
	});

	test("serialises concurrent callers (never two in flight)", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const { gate } = setup(10, async (url) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			return url;
		});
		const out = await Promise.all(
			["1", "2", "3", "4"].map((u) => gate.fetchPage(u)),
		);
		expect(out).toEqual(["1", "2", "3", "4"]);
		expect(maxInFlight).toBe(1);
	});

	test("request cap is exact under concurrency", async () => {
		const { gate } = setup(3);
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, (_, i) => gate.fetchPage(`u${i}`)),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
		const rejected = results.filter((r) => r.status === "rejected");
		expect(rejected).toHaveLength(3);
		expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
			"request cap 3 reached",
		);
		expect(gate.requests()).toBe(3);
		expect(gate.capReached()).toBe(true);
	});

	test("a failed fetch counts, rejects its caller, and does not poison the queue", async () => {
		const { gate } = setup(10, async (url) => {
			if (url === "bad") {
				throw new Error("boom");
			}
			return url;
		});
		const [bad, good] = await Promise.allSettled([
			gate.fetchPage("bad"),
			gate.fetchPage("good"),
		]);
		expect(bad.status).toBe("rejected");
		expect(good.status).toBe("fulfilled");
		expect(gate.requests()).toBe(2);
		expect(gate.capReached()).toBe(false);
	});
});
