import { describe, expect, test } from "bun:test";
import { scrollOf, withScroll } from "./scroll-state";

describe("scrollOf", () => {
	test("reads a saved position", () => {
		expect(scrollOf({ scrollY: 420 })).toBe(420);
		expect(scrollOf({ from: "/?q=a", scrollY: 0 })).toBe(0);
	});

	test("is null for anything that is not a usable position", () => {
		expect(scrollOf(null)).toBeNull();
		expect(scrollOf(undefined)).toBeNull();
		expect(scrollOf("x")).toBeNull();
		expect(scrollOf({})).toBeNull();
		expect(scrollOf({ scrollY: "10" })).toBeNull();
		expect(scrollOf({ scrollY: -5 })).toBeNull();
		expect(scrollOf({ scrollY: Number.NaN })).toBeNull();
	});
});

describe("withScroll", () => {
	test("keeps the existing keys", () => {
		expect(withScroll({ from: "/?q=a" }, 300)).toEqual({
			from: "/?q=a",
			scrollY: 300,
		});
	});

	test("starts from nothing when there is no state", () => {
		expect(withScroll(null, 12.6)).toEqual({ scrollY: 13 });
	});

	test("never stores a negative position", () => {
		expect(withScroll({}, -40)).toEqual({ scrollY: 0 });
	});
});
