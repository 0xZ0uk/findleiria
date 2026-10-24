import { describe, expect, test } from "bun:test";

import { buildSource, bundleNeedles } from "./snapshot-lib.mjs";

const D1_ENV = {
	CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
	EVENTS_D1_ID: "11111111-2222-3333-4444-555555555555",
	D1_READ_API_TOKEN: "read-token-value",
};

describe("buildSource", () => {
	test("reads D1 when the three D1 vars are set", () => {
		expect(buildSource(D1_ENV)).toEqual({
			kind: "d1",
			accountId: D1_ENV.CLOUDFLARE_ACCOUNT_ID,
			databaseId: D1_ENV.EVENTS_D1_ID,
			token: D1_ENV.D1_READ_API_TOKEN,
		});
	});

	test("a file: SNAPSHOT_DATABASE_URL reads libSQL, even with D1 set", () => {
		expect(
			buildSource({ ...D1_ENV, SNAPSHOT_DATABASE_URL: "file:/tmp/local.db" }),
		).toEqual({ kind: "file", url: "file:/tmp/local.db" });
		expect(
			buildSource({ SNAPSHOT_DATABASE_URL: "file:/tmp/local.db" }),
		).toEqual({ kind: "file", url: "file:/tmp/local.db" });
	});

	test("a remote SNAPSHOT_DATABASE_URL is refused", () => {
		expect(() =>
			buildSource({ ...D1_ENV, SNAPSHOT_DATABASE_URL: "libsql://x.turso.io" }),
		).toThrow(/must be a `file:` URL/);
	});

	test("missing config fails with a message naming what is missing", () => {
		expect(() => buildSource({})).toThrow(
			/Missing CLOUDFLARE_ACCOUNT_ID, EVENTS_D1_ID, D1_READ_API_TOKEN.*SNAPSHOT_DATABASE_URL=file:/s,
		);
		expect(() =>
			buildSource({ ...D1_ENV, D1_READ_API_TOKEN: undefined }),
		).toThrow(/^Missing D1_READ_API_TOKEN:/);
		expect(() => buildSource({ ...D1_ENV, EVENTS_D1_ID: "" })).toThrow(
			/^Missing EVENTS_D1_ID:/,
		);
	});
});

describe("bundleNeedles", () => {
	test("D1: the database id, the token, the API path and libsql", () => {
		expect(bundleNeedles(buildSource(D1_ENV))).toEqual([
			"libsql",
			D1_ENV.EVENTS_D1_ID,
			D1_ENV.D1_READ_API_TOKEN,
			"api.cloudflare.com/client/v4/accounts",
		]);
	});

	test("a local file: libsql only, and never an empty needle", () => {
		expect(bundleNeedles({ kind: "file", url: "file:/tmp/local.db" })).toEqual([
			"libsql",
		]);
		expect(
			bundleNeedles({ kind: "d1", databaseId: "", token: "", accountId: "a" }),
		).toEqual(["libsql", "api.cloudflare.com/client/v4/accounts"]);
	});
});
