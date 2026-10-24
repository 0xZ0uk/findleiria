import { describe, expect, test } from "bun:test";

import {
	giveUpMessage,
	MAX_PARSE_ATTEMPTS,
	mergeAttempts,
	type ParseAttempts,
	recordParseFailure,
} from "./parse-attempts";

describe("recordParseFailure", () => {
	test("counts up from the saved attempts and exhausts at the cap", () => {
		const pending: ParseAttempts = {};
		expect(
			recordParseFailure(
				{ "https://a.test/1": 1 },
				pending,
				"https://a.test/1",
			),
		).toEqual({ count: 2, exhausted: false });
		expect(
			recordParseFailure({ "https://a.test/1": 2 }, {}, "https://a.test/1"),
		).toEqual({ count: MAX_PARSE_ATTEMPTS, exhausted: true });
	});

	test("state without attempts counts from zero", () => {
		const pending: ParseAttempts = {};
		expect(recordParseFailure(undefined, pending, "u").count).toBe(1);
		expect(pending).toEqual({ u: 1 });
	});
});

describe("mergeAttempts", () => {
	test("pending updates previous; resolved urls are dropped", () => {
		expect(mergeAttempts({ a: 1, b: 2, c: 1 }, { a: 2, d: 1 }, ["b"])).toEqual({
			a: 2,
			c: 1,
			d: 1,
		});
		expect(mergeAttempts(undefined, {}, [])).toEqual({});
	});
});

test("giveUpMessage names the url and the cap", () => {
	expect(giveUpMessage("https://a.test/1")).toBe(
		"unparseable after 3 attempts, not retrying: https://a.test/1",
	);
});
