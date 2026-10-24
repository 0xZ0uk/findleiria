// bun test for the R2 sync of the OG card cache, against an in-memory fake of
// R2's S3 API (injected as `fetch`): key mapping, signing, pagination, error
// tolerance, and the no-config no-op. Nothing here touches the network.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OG_CACHE_VERSION } from "./og-cache.mjs";
import {
	cacheKeyOf,
	createR2Cache,
	formatR2Stats,
	objectKey,
	parseListPage,
	R2_PREFIX,
} from "./og-r2.mjs";

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("fake-card"),
]);

const ENV = {
	R2_ACCOUNT_ID: "acct123",
	R2_ACCESS_KEY_ID: "AKIATESTKEY",
	R2_SECRET_ACCESS_KEY: "test-secret-do-not-leak",
	R2_BUILD_CACHE_BUCKET: "build-cache",
};

let root;
let cacheDir;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "og-r2-"));
	cacheDir = path.join(root, "og-cards");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function logger() {
	const lines = { log: [], warn: [] };
	return {
		lines,
		log: (line) => lines.log.push(line),
		warn: (line) => lines.warn.push(line),
	};
}

const png = (label) => Buffer.concat([PNG, Buffer.from(label)]);

/** In-memory bucket answering the S3 calls og-r2.mjs makes. */
function fakeBucket(initial = {}, { pageSize = 1000 } = {}) {
	const objects = new Map(
		Object.entries(initial).map(([name, body]) => [name, body]),
	);
	const requests = [];
	const failing = new Set(); // "METHOD name" or "LIST"
	const fetch = async (request) => {
		const url = new URL(request.url);
		const method = request.method;
		const name = decodeURIComponent(url.pathname.replace("/build-cache/", ""));
		const isList =
			url.pathname === "/build-cache" || url.pathname === "/build-cache/";
		requests.push({ method, url, headers: request.headers });
		if (failing.has(isList ? "LIST" : `${method} ${name}`)) {
			return new Response("boom", { status: 500 });
		}
		if (isList) {
			const prefix = url.searchParams.get("prefix") ?? "";
			const names = [...objects.keys()]
				.filter((n) => n.startsWith(prefix))
				.sort();
			const start = Number(url.searchParams.get("continuation-token") ?? 0);
			const page = names.slice(start, start + pageSize);
			const more = start + pageSize < names.length;
			return new Response(
				`<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>` +
					(more
						? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>`
						: "") +
					page.map((n) => `<Contents><Key>${n}</Key></Contents>`).join("") +
					"</ListBucketResult>",
			);
		}
		if (method === "GET") {
			return objects.has(name)
				? new Response(objects.get(name))
				: new Response("<Error><Code>NoSuchKey</Code></Error>", {
						status: 404,
					});
		}
		if (method === "PUT") {
			objects.set(name, Buffer.from(await request.arrayBuffer()));
			return new Response(null, { status: 200 });
		}
		if (method === "DELETE") {
			objects.delete(name);
			return new Response(null, { status: 204 });
		}
		return new Response("?", { status: 400 });
	};
	return { objects, requests, failing, fetch };
}

function make(bucket, extra = {}) {
	const log = logger();
	const r2 = createR2Cache({
		cacheDir,
		env: ENV,
		fetch: bucket.fetch,
		logger: log,
		...extra,
	});
	return { r2, log };
}

const writeLocal = (key, body = png(key)) => {
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(path.join(cacheDir, `${key}.png`), body);
};

test("objects live under a versioned prefix and map back to cache keys", () => {
	expect(R2_PREFIX).toBe(`og-cards/v${OG_CACHE_VERSION}/`);
	expect(objectKey("abc123")).toBe(`${R2_PREFIX}abc123.png`);
	expect(cacheKeyOf(objectKey("abc123"))).toBe("abc123");
	expect(cacheKeyOf("og-cards/v999/abc123.png")).toBeNull();
	expect(cacheKeyOf(`${R2_PREFIX}notes.txt`)).toBeNull();
});

test("parseListPage reads keys and the continuation token", () => {
	expect(
		parseListPage(
			"<R><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken>" +
				"<Contents><Key>k1</Key></Contents><Contents><Key>k2</Key></Contents></R>",
		),
	).toEqual({ keys: ["k1", "k2"], next: "a&b" });
	expect(parseListPage("<R><IsTruncated>false</IsTruncated></R>")).toEqual({
		keys: [],
		next: null,
	});
});

test("missing config logs one line, touches nothing, and never calls fetch", async () => {
	const calls = [];
	const log = logger();
	const r2 = createR2Cache({
		cacheDir,
		env: { R2_ACCOUNT_ID: "acct123" },
		fetch: async (request) => calls.push(request),
		logger: log,
	});

	await r2.pull(["a"]);
	await r2.push(["a"]);
	await r2.prune(["a"]);

	expect(r2.enabled).toBe(false);
	expect(calls).toEqual([]);
	expect(log.lines.log).toHaveLength(1);
	expect(log.lines.log[0]).toContain("R2_ACCESS_KEY_ID");
	expect(log.lines.log[0]).toContain("cold build");
	expect(log.lines.warn).toEqual([]);
	// Not even the cache directory: exactly today's behaviour.
	expect(fs.existsSync(cacheDir)).toBe(false);
});

test("blank values count as missing config", () => {
	const log = logger();
	const r2 = createR2Cache({
		cacheDir,
		env: { ...ENV, R2_BUILD_CACHE_BUCKET: "  " },
		fetch: async () => {
			throw new Error("must not be called");
		},
		logger: log,
	});
	expect(r2.enabled).toBe(false);
	expect(log.lines.log[0]).toContain("R2_BUILD_CACHE_BUCKET");
});

test("pull downloads the keys R2 has, counts misses, and skips what is local", async () => {
	const bucket = fakeBucket({
		[objectKey("have")]: png("have"),
		[objectKey("local")]: png("remote-copy"),
	});
	writeLocal("local", png("local-copy"));
	const { r2 } = make(bucket);

	await r2.pull(["have", "gone", "local"]);

	expect(fs.readFileSync(path.join(cacheDir, "have.png"))).toEqual(png("have"));
	expect(fs.existsSync(path.join(cacheDir, "gone.png"))).toBe(false);
	// A local copy is never overwritten, and costs no request.
	expect(fs.readFileSync(path.join(cacheDir, "local.png"))).toEqual(
		png("local-copy"),
	);
	expect(bucket.requests.map((r) => r.url.pathname).sort()).toEqual([
		`/build-cache/${objectKey("gone")}`,
		`/build-cache/${objectKey("have")}`,
	]);
	expect(r2.stats).toMatchObject({ hits: 1, misses: 1, local: 1, errors: 0 });
	// No temp files left behind.
	expect(fs.readdirSync(cacheDir).sort()).toEqual(["have.png", "local.png"]);
});

test("requests go to the account endpoint, signed with the access key", async () => {
	const bucket = fakeBucket({ [objectKey("a")]: png("a") });
	const { r2 } = make(bucket);
	await r2.pull(["a"]);

	const [request] = bucket.requests;
	expect(request.url.origin).toBe("https://acct123.r2.cloudflarestorage.com");
	const auth = request.headers.get("authorization");
	expect(auth).toStartWith("AWS4-HMAC-SHA256 Credential=AKIATESTKEY/");
	expect(auth).toContain("/auto/s3/aws4_request");
	// The secret signs the request; it is never sent.
	expect(auth).not.toContain(ENV.R2_SECRET_ACCESS_KEY);
});

test("pull treats a non-PNG body and server errors as misses and keeps going", async () => {
	const bucket = fakeBucket({
		[objectKey("bad")]: Buffer.from("<html>not a png</html>"),
		[objectKey("boom")]: png("boom"),
		[objectKey("fine")]: png("fine"),
	});
	bucket.failing.add(`GET ${objectKey("boom")}`);
	const { r2, log } = make(bucket);

	await r2.pull(["bad", "boom", "fine"]);

	expect(fs.readdirSync(cacheDir)).toEqual(["fine.png"]);
	expect(r2.stats).toMatchObject({ hits: 1, misses: 2, errors: 2 });
	expect(log.lines.warn).toHaveLength(2);
	expect(log.lines.warn.join("\n")).not.toContain(ENV.R2_SECRET_ACCESS_KEY);
});

test("pull survives fetch throwing (network down)", async () => {
	const { r2, log } = make({
		fetch: async () => {
			throw new Error("ECONNRESET");
		},
	});
	await r2.pull(["a", "b"]);
	expect(r2.stats).toMatchObject({ hits: 0, misses: 2, errors: 2 });
	expect(log.lines.warn[0]).toContain("ECONNRESET");
});

test("pull never has more than `concurrency` requests in flight", async () => {
	let inFlight = 0;
	let peak = 0;
	const fetch = async () => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 5));
		inFlight -= 1;
		return new Response("", { status: 404 });
	};
	const { r2 } = make({ fetch }, { concurrency: 3 });
	await r2.pull(Array.from({ length: 10 }, (_, i) => `k${i}`));
	expect(peak).toBe(3);
	expect(r2.stats.misses).toBe(10);
});

test("push uploads the given cards as image/png under the prefix", async () => {
	const bucket = fakeBucket();
	writeLocal("new1");
	writeLocal("new2");
	const { r2 } = make(bucket);

	await r2.push(["new1", "new2"]);

	expect([...bucket.objects.keys()].sort()).toEqual([
		objectKey("new1"),
		objectKey("new2"),
	]);
	expect(bucket.objects.get(objectKey("new1"))).toEqual(png("new1"));
	expect(bucket.requests[0].headers.get("content-type")).toBe("image/png");
	expect(r2.stats).toMatchObject({ uploads: 2, errors: 0 });
});

test("push tolerates a failed upload and a missing local file", async () => {
	const bucket = fakeBucket();
	bucket.failing.add(`PUT ${objectKey("bad")}`);
	writeLocal("bad");
	writeLocal("good");
	const { r2, log } = make(bucket);

	await r2.push(["bad", "ghost", "good"]);

	expect([...bucket.objects.keys()]).toEqual([objectKey("good")]);
	expect(r2.stats).toMatchObject({ uploads: 1, errors: 2 });
	expect(log.lines.warn).toHaveLength(2);
});

test("prune walks every page of the listing and deletes only unused cards", async () => {
	const bucket = fakeBucket(
		{
			[objectKey("keep1")]: png("1"),
			[objectKey("keep2")]: png("2"),
			[objectKey("old1")]: png("3"),
			[objectKey("old2")]: png("4"),
			[objectKey("old3")]: png("5"),
			// Not ours: other version, non-card file under our prefix, other prefix.
			"og-cards/v999/old.png": png("6"),
			[`${R2_PREFIX}README.txt`]: Buffer.from("hi"),
			"elsewhere/old1.png": png("7"),
		},
		{ pageSize: 2 },
	);
	const { r2 } = make(bucket);

	await r2.prune(["keep1", "keep2"]);

	// 6 objects under the prefix at 2 per page = 3 list calls (+ 3 deletes).
	const lists = bucket.requests.filter((r) => r.method === "GET");
	expect(lists).toHaveLength(3);
	expect(lists[0].url.searchParams.get("prefix")).toBe(R2_PREFIX);
	expect(lists[0].url.searchParams.get("list-type")).toBe("2");
	expect(lists[1].url.searchParams.get("continuation-token")).toBe("2");
	expect([...bucket.objects.keys()].sort()).toEqual(
		[
			objectKey("keep1"),
			objectKey("keep2"),
			"og-cards/v999/old.png",
			`${R2_PREFIX}README.txt`,
			"elsewhere/old1.png",
		].sort(),
	);
	expect(r2.stats).toMatchObject({ deletes: 3, errors: 0 });
});

test("prune with no live keys deletes nothing", async () => {
	const bucket = fakeBucket({ [objectKey("a")]: png("a") });
	const { r2 } = make(bucket);
	await r2.prune([]);
	expect(bucket.requests).toEqual([]);
	expect(bucket.objects.size).toBe(1);
});

test("prune: a failed listing deletes nothing and warns", async () => {
	const bucket = fakeBucket({ [objectKey("old")]: png("old") });
	bucket.failing.add("LIST");
	const { r2, log } = make(bucket);

	await r2.prune(["live"]);

	expect(bucket.objects.size).toBe(1);
	expect(r2.stats).toMatchObject({ deletes: 0, errors: 1 });
	expect(log.lines.warn).toHaveLength(1);
});

test("prune: a failed delete is counted and the rest still go", async () => {
	const bucket = fakeBucket({
		[objectKey("old1")]: png("1"),
		[objectKey("old2")]: png("2"),
	});
	bucket.failing.add(`DELETE ${objectKey("old1")}`);
	const { r2 } = make(bucket);

	await r2.prune(["live"]);

	expect([...bucket.objects.keys()]).toEqual([objectKey("old1")]);
	expect(r2.stats).toMatchObject({ deletes: 1, errors: 1 });
});

test("a full second build round-trips: nothing to render, nothing to upload", async () => {
	const bucket = fakeBucket();
	// Build 1: cold. Everything is a miss, then everything is uploaded.
	writeLocal("a");
	writeLocal("b");
	const first = make(bucket);
	await first.r2.push(["a", "b"]);
	await first.r2.prune(["a", "b"]);

	// Build 2: a fresh machine (empty cache dir) with the same corpus.
	fs.rmSync(cacheDir, { recursive: true });
	const second = make(bucket);
	await second.r2.pull(["a", "b"]);

	expect(fs.readdirSync(cacheDir).sort()).toEqual(["a.png", "b.png"]);
	expect(second.r2.stats).toMatchObject({ hits: 2, misses: 0, uploads: 0 });
	expect(formatR2Stats(second.r2.stats)).toContain("2 downloaded");
});
