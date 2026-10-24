import { describe, expect, test } from "bun:test";

import { defaultSleep, randomDelay } from "./timing";

describe("randomDelay", () => {
	test("stays within [base, base + spread - 1]", () => {
		for (let i = 0; i < 500; i++) {
			const d = randomDelay(300, 200);
			expect(d).toBeGreaterThanOrEqual(300);
			expect(d).toBeLessThanOrEqual(499);
			expect(Number.isInteger(d)).toBe(true);
		}
	});

	test("defaults to 350 + [0, 300)", () => {
		for (let i = 0; i < 200; i++) {
			const d = randomDelay();
			expect(d).toBeGreaterThanOrEqual(350);
			expect(d).toBeLessThanOrEqual(649);
		}
	});

	test("a spread of 1 is a fixed delay", () => {
		expect(randomDelay(120, 1)).toBe(120);
	});
});

describe("defaultSleep", () => {
	test("resolves after the delay", async () => {
		const t0 = Date.now();
		await defaultSleep(15);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
	});
});
