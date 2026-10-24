import { describe, expect, test } from "bun:test";

import {
	buildSource,
	bundleNeedles,
	isWorkersBuild,
	siteOrigin,
} from "./snapshot-lib.mjs";

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
			buildSource({
				...D1_ENV,
				SNAPSHOT_DATABASE_URL: "libsql://db.example.invalid",
			}),
		).toThrow(/must be a `file:` URL/);
	});

	test("on Workers Builds D1 is mandatory and a file: URL is refused", () => {
		const ci = { ...D1_ENV, WORKERS_CI: "1" };
		expect(buildSource(ci)).toMatchObject({ kind: "d1" });
		expect(() =>
			buildSource({ ...ci, SNAPSHOT_DATABASE_URL: "file:/tmp/local.db" }),
		).toThrow(/Workers Builds.*refusing a local snapshot source/s);
		// With nothing set it still asks for D1, not for a file.
		expect(() => buildSource({ WORKERS_CI: "1" })).toThrow(
			/^Missing CLOUDFLARE_ACCOUNT_ID/,
		);
	});

	test("the override keeps working off Workers Builds", () => {
		for (const WORKERS_CI of [undefined, "", "0", "false"]) {
			expect(
				buildSource({
					WORKERS_CI,
					SNAPSHOT_DATABASE_URL: "file:/tmp/local.db",
				}),
			).toEqual({ kind: "file", url: "file:/tmp/local.db" });
		}
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

describe("isWorkersBuild", () => {
	test("is set by WORKERS_CI=1 only", () => {
		expect(isWorkersBuild({ WORKERS_CI: "1" })).toBe(true);
		expect(isWorkersBuild({ WORKERS_CI: "true" })).toBe(true);
		for (const value of [undefined, "", "0", "false", "FALSE"]) {
			expect(isWorkersBuild({ WORKERS_CI: value })).toBe(false);
		}
		expect(isWorkersBuild({})).toBe(false);
	});
});

describe("siteOrigin", () => {
	test("returns the origin and host, dropping a trailing slash", () => {
		expect(siteOrigin({ SITE_URL: "https://findleiria.pt" })).toEqual({
			origin: "https://findleiria.pt",
			host: "findleiria.pt",
		});
		expect(siteOrigin({ SITE_URL: " https://findleiria.pt/ " })).toEqual({
			origin: "https://findleiria.pt",
			host: "findleiria.pt",
		});
		expect(siteOrigin({ SITE_URL: "http://localhost:3300" })).toEqual({
			origin: "http://localhost:3300",
			host: "localhost:3300",
		});
	});

	test("is required, with no default", () => {
		expect(() => siteOrigin({})).toThrow(/^Missing SITE_URL/);
		expect(() => siteOrigin({ SITE_URL: "  " })).toThrow(/^Missing SITE_URL/);
	});

	test("refuses anything that is not a bare http(s) origin", () => {
		expect(() => siteOrigin({ SITE_URL: "findleiria.pt" })).toThrow(
			/not a valid URL/,
		);
		expect(() => siteOrigin({ SITE_URL: "ftp://findleiria.pt" })).toThrow(
			/must be http/,
		);
		for (const bad of [
			"https://findleiria.pt/app",
			"https://findleiria.pt/?x=1",
			"https://findleiria.pt/#top",
		]) {
			expect(() => siteOrigin({ SITE_URL: bad })).toThrow(/without a path/);
		}
	});
});
