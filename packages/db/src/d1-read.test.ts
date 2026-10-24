import { describe, expect, test } from "bun:test";

import { inlineParams } from "./d1-read";
import { D1Error, parseD1RawResponse } from "./d1-rest";

describe("inlineParams", () => {
	test("binds strings, inlines numbers, in placeholder order", () => {
		expect(
			inlineParams(
				'select * from "events" where "slug" = ? and "start_at" >= ? and "venue" = ? limit ?',
				["2026", 1_792_670_400, "Música", 1],
			),
		).toEqual({
			sql: 'select * from "events" where "slug" = ? and "start_at" >= 1792670400 and "venue" = ? limit 1',
			params: ["2026", "Música"],
		});
	});

	test("keeps a numeric-looking string a string", () => {
		expect(inlineParams("select ?", ["42"])).toEqual({
			sql: "select ?",
			params: ["42"],
		});
	});

	test("writes null, booleans, bigints, doubles and blobs as literals", () => {
		expect(
			inlineParams("values (?, ?, ?, ?, ?, ?)", [
				null,
				true,
				false,
				2n ** 63n - 1n,
				0.1,
				new Uint8Array([0, 255]),
			]).sql,
		).toBe("values (NULL, 1, 0, 9223372036854775807, 0.1, x'00ff')");
	});

	test("parenthesises negatives so `a -?` cannot start a comment", () => {
		expect(inlineParams("select a -? from t", [-5]).sql).toBe(
			"select a -(-5) from t",
		);
		expect(inlineParams("select ?", [-0.5]).sql).toBe("select (-0.5)");
	});

	test("ignores ? inside quotes, identifiers and comments", () => {
		const sql =
			"select '?' as a, \"?\" as \"it's\", `?`, [?] -- why?\nfrom t /* ? */ where x = ? and y = 'it''s ?'";
		expect(inlineParams(sql, [7])).toEqual({
			sql: sql.replace("x = ?", "x = 7"),
			params: [],
		});
	});

	test("refuses a parameter/placeholder mismatch and values it cannot write", () => {
		expect(() => inlineParams("select ?, ?", [1])).toThrow(/placeholders/);
		expect(() => inlineParams("select ?", [1, 2])).toThrow(/parameters/);
		expect(() => inlineParams("select ?", [Number.NaN])).toThrow(/cannot bind/);
		expect(() => inlineParams("select ?", [{}])).toThrow(/cannot bind/);
	});
});

describe("parseD1RawResponse", () => {
	test("returns columns and array rows per statement", () => {
		expect(
			parseD1RawResponse(
				200,
				JSON.stringify({
					success: true,
					errors: [],
					result: [
						{
							results: {
								columns: ["id", "title"],
								rows: [
									[1, "a"],
									[2, null],
								],
							},
							success: true,
							meta: { rows_read: 2 },
						},
					],
				}),
			),
		).toEqual([
			{
				columns: ["id", "title"],
				rows: [
					[1, "a"],
					[2, null],
				],
				meta: { rows_read: 2 },
			},
		]);
	});

	test("rejects /query-shaped results, SQL errors and bad bodies", () => {
		expect(() =>
			parseD1RawResponse(
				200,
				JSON.stringify({
					success: true,
					result: [{ results: [{ id: 1 }], success: true }],
				}),
			),
		).toThrow(/without rows/);
		expect(() =>
			parseD1RawResponse(
				400,
				JSON.stringify({
					success: false,
					errors: [{ code: 7500, message: "no such table: nope" }],
				}),
			),
		).toThrow("D1 query failed (HTTP 400): 7500: no such table: nope");
		expect(() => parseD1RawResponse(502, "<html>")).toThrow(D1Error);
	});
});
