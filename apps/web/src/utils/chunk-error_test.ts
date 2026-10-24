import { describe, expect, test } from "bun:test";
import { isChunkLoadError } from "./chunk-error";

describe("isChunkLoadError", () => {
	test("recognises the stale-chunk messages of the major browsers", () => {
		for (const message of [
			"Failed to fetch dynamically imported module: https://x/assets/concelho-map-abc.js",
			"error loading dynamically imported module",
			"Importing a module script failed.",
			"Loading chunk 12 failed.",
			"Unable to preload CSS for /assets/map.css",
		]) {
			expect(isChunkLoadError(new TypeError(message))).toBe(true);
		}
	});

	test("leaves ordinary render errors alone", () => {
		expect(isChunkLoadError(new Error("x is not a function"))).toBe(false);
		expect(isChunkLoadError(null)).toBe(false);
		expect(isChunkLoadError(undefined)).toBe(false);
		expect(isChunkLoadError({ message: "Loading chunk 1 failed" })).toBe(false);
	});
});
