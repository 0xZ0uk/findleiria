// Persists the OG card cache in an R2 bucket between builds, so a build on a
// host with no restored node_modules (Cloudflare) still renders only the cards
// whose inputs changed. Talks to R2's S3-compatible API with aws4fetch; the
// cache itself (keys, rendering) stays in og-cache.mjs, which has no network.
//
// Three steps around buildCards:
//   pull(keys)   download the needed keys that R2 has into the cache directory
//   push(keys)   upload the cards this build rendered
//   prune(live)  delete bucket objects this build did not use
//
// A cache must never fail a build: every R2 error is counted and warned about,
// then the build carries on (worst case it renders what it could not fetch).
// Without R2 config nothing runs and the build is cold, exactly as before.
//
// Objects live at `og-cards/v<OG_CACHE_VERSION>/<key>.png`. Bumping the version
// starts a fresh namespace; the old one is left alone (nothing lists above the
// prefix), so delete it by hand if the bucket should shrink.

import fs from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { mapPool, OG_CACHE_VERSION } from "./og-cache.mjs";

export const R2_PREFIX = `og-cards/v${OG_CACHE_VERSION}/`;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_LIST_PAGES = 1000;

const CONFIG_VARS = [
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_BUILD_CACHE_BUCKET",
];

export function objectKey(key) {
	return `${R2_PREFIX}${key}.png`;
}

/** The cache key behind an object name, or null for anything we did not write. */
export function cacheKeyOf(objectName) {
	if (!objectName.startsWith(R2_PREFIX) || !objectName.endsWith(".png")) {
		return null;
	}
	return objectName.slice(R2_PREFIX.length, -".png".length);
}

function decodeXml(text) {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Pull the fields we use out of a ListObjectsV2 response. */
export function parseListPage(xml) {
	const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) =>
		decodeXml(m[1]),
	);
	const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
	const token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(
		xml,
	);
	return { keys, next: truncated && token ? decodeXml(token[1]) : null };
}

/**
 * @param {object} opts
 * @param {string} opts.cacheDir  the local cache directory (OG_CACHE_DIR)
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {typeof fetch} [opts.fetch]  injectable for tests
 * @param {{log: Function, warn: Function}} [opts.logger]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.timeoutMs]  per request
 */
export function createR2Cache({
	cacheDir,
	env = process.env,
	fetch: fetchImpl = globalThis.fetch,
	logger = console,
	concurrency = 8,
	timeoutMs = 30_000,
}) {
	const stats = {
		hits: 0,
		local: 0,
		misses: 0,
		uploads: 0,
		deletes: 0,
		errors: 0,
	};
	const missing = CONFIG_VARS.filter((name) => !env[name]?.trim());
	if (missing.length > 0) {
		logger.log(
			`[og-r2] not configured (${missing.join(", ")} unset): cold build, no remote cache`,
		);
		const none = async () => {};
		return { enabled: false, stats, pull: none, push: none, prune: none };
	}

	const aws = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID.trim(),
		secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim(),
		service: "s3",
		region: "auto",
	});
	const bucketUrl = `https://${env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUILD_CACHE_BUCKET.trim())}`;

	const send = async (method, objectName, { query, body, headers } = {}) => {
		const url = new URL(objectName ? `${bucketUrl}/${objectName}` : bucketUrl);
		for (const [name, value] of Object.entries(query ?? {})) {
			url.searchParams.set(name, value);
		}
		const request = await aws.sign(url, {
			method,
			body,
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		return fetchImpl(request);
	};

	const fail = (what, error) => {
		stats.errors += 1;
		logger.warn(
			`[og-r2] ${what} failed, continuing: ${error instanceof Error ? error.message : error}`,
		);
	};

	const httpError = (response) => new Error(`HTTP ${response.status}`);

	/** Download the needed keys R2 has; never throws. */
	async function pull(keysNeeded) {
		fs.mkdirSync(cacheDir, { recursive: true });
		await mapPool(keysNeeded, concurrency, async (key) => {
			const file = path.join(cacheDir, `${key}.png`);
			if (fs.existsSync(file)) {
				stats.local += 1;
				return;
			}
			try {
				const response = await send("GET", objectKey(key));
				if (response.status === 404) {
					stats.misses += 1;
					return;
				}
				if (!response.ok) throw httpError(response);
				const png = Buffer.from(await response.arrayBuffer());
				// A truncated or foreign body is a miss, never a broken og:image.
				if (
					png.length <= PNG_MAGIC.length ||
					!png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
				) {
					throw new Error("body is not a PNG");
				}
				const tmp = `${file}.${process.pid}.tmp`;
				fs.writeFileSync(tmp, png);
				fs.renameSync(tmp, file);
				stats.hits += 1;
			} catch (error) {
				stats.misses += 1;
				fail(`download of ${key}`, error);
			}
		});
	}

	/** Upload cards rendered this build; never throws. */
	async function push(newKeys) {
		await mapPool(newKeys, concurrency, async (key) => {
			try {
				const body = fs.readFileSync(path.join(cacheDir, `${key}.png`));
				const response = await send("PUT", objectKey(key), {
					body,
					headers: { "content-type": "image/png" },
				});
				if (!response.ok) throw httpError(response);
				stats.uploads += 1;
			} catch (error) {
				fail(`upload of ${key}`, error);
			}
		});
	}

	/** Every object name under the prefix; throws if listing breaks. */
	async function listAll() {
		const names = [];
		let token;
		for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
			const response = await send("GET", "", {
				query: {
					"list-type": "2",
					prefix: R2_PREFIX,
					...(token ? { "continuation-token": token } : {}),
				},
			});
			if (!response.ok) throw httpError(response);
			const { keys, next } = parseListPage(await response.text());
			names.push(...keys);
			if (!next) return names;
			token = next;
		}
		throw new Error(`listing did not finish in ${MAX_LIST_PAGES} pages`);
	}

	/** Delete objects the build did not use; never throws. */
	async function prune(liveKeys) {
		// An empty live set means something upstream went wrong, not "delete all".
		if (liveKeys.length === 0) return;
		const live = new Set(liveKeys);
		let names;
		try {
			names = await listAll();
		} catch (error) {
			fail("listing the bucket", error);
			return;
		}
		// Only our own `<key>.png` objects are candidates; anything else under
		// the prefix is not ours to delete.
		const stale = names.filter((name) => {
			const key = cacheKeyOf(name);
			return key !== null && !live.has(key);
		});
		await mapPool(stale, concurrency, async (name) => {
			try {
				const response = await send("DELETE", name);
				if (!response.ok && response.status !== 404) {
					throw httpError(response);
				}
				stats.deletes += 1;
			} catch (error) {
				fail(`delete of ${name}`, error);
			}
		});
	}

	return { enabled: true, stats, pull, push, prune };
}

/** One summary line for the build log. */
export function formatR2Stats(stats) {
	return `[og-r2] ${stats.hits} downloaded, ${stats.local} already local, ${stats.misses} not in R2, ${stats.uploads} uploaded, ${stats.deletes} deleted, ${stats.errors} errors`;
}
