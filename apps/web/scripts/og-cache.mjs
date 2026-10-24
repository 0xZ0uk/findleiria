// Content-addressed cache for the OG cards, so a build only renders the cards
// whose inputs changed. Pure Node, no satori/resvg import: the renderer is
// passed in, which keeps this module cheap to test.
//
// A card is keyed by a hash of exactly what shapes the image: the three strings
// the renderer draws (title, day, venue) plus a fingerprint of the template
// (renderer source + font files). Anything else about the event (description,
// image, category) never reaches the PNG, so it must not invalidate the key.
//
// Entries live in `<cacheDir>/<key>.png`. After each build, entries the build
// did not use are deleted, so the directory never outgrows the live corpus.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Bump to force every card to re-render (the template fingerprint covers edits). */
export const OG_CACHE_VERSION = 1;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Hash of the files that define the card's look; any edit re-renders all. */
export function templateFingerprint(files) {
	const hash = createHash("sha256");
	hash.update(`v${OG_CACHE_VERSION}\0`);
	for (const file of files) {
		hash.update(path.basename(file));
		hash.update("\0");
		hash.update(fs.readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** The renderer's own fallbacks, applied first so equal images share a key. */
export function normalizeCardInput({ title, dayLabel, venueLabel }) {
	return {
		title: title?.trim() ? title.trim() : "Evento",
		dayLabel: dayLabel?.trim() ? dayLabel.trim() : "",
		venueLabel: venueLabel?.trim() ? venueLabel.trim() : "Leiria",
	};
}

export function cardKey(input, fingerprint) {
	const { title, dayLabel, venueLabel } = normalizeCardInput(input);
	return createHash("sha256")
		.update(JSON.stringify([fingerprint, title, dayLabel, venueLabel]))
		.digest("hex")
		.slice(0, 32);
}

/** Distinct keys a build over `entries` needs (identical card text shares one). */
export function liveCardKeys(entries, fingerprint) {
	return [...new Set(entries.map((entry) => cardKey(entry, fingerprint)))];
}

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
export async function mapPool(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
	);
	return results;
}

function readCached(file) {
	try {
		const png = fs.readFileSync(file);
		// A truncated or foreign file is a miss, never a broken og:image.
		return png.length > PNG_MAGIC.length &&
			png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
			? png
			: null;
	} catch {
		return null;
	}
}

/**
 * Write `<outDir>/<slug>.png` for every entry, rendering only cache misses.
 *
 * @param {object} opts
 * @param {{slug: string, title: string, dayLabel: string, venueLabel: string}[]} opts.entries
 * @param {string} opts.cacheDir  survives between builds; created if missing
 * @param {string} opts.outDir    the build output's og/ directory
 * @param {string} opts.fingerprint  from templateFingerprint
 * @param {(input) => Promise<Buffer>} opts.render
 * @param {number} [opts.concurrency]
 * @returns {Promise<{cards: number, rendered: number, reused: number, evicted: number, renderedKeys: string[]}>}
 *   `renderedKeys` are the cache keys drawn this build (what is new to a remote store)
 */
export async function buildCards({
	entries,
	cacheDir,
	outDir,
	fingerprint,
	render,
	concurrency = 4,
}) {
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.mkdirSync(outDir, { recursive: true });

	// Events with identical card text share one render.
	const byKey = new Map();
	for (const entry of entries) {
		const key = cardKey(entry, fingerprint);
		if (!byKey.has(key)) byKey.set(key, entry);
	}

	const renderedKeys = [];
	let reused = 0;
	await mapPool([...byKey], concurrency, async ([key, entry]) => {
		const file = path.join(cacheDir, `${key}.png`);
		if (readCached(file)) {
			reused += 1;
			return;
		}
		const png = await render(normalizeCardInput(entry));
		// Rename into place: a build killed mid-write leaves no half-card.
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, png);
		fs.renameSync(tmp, file);
		renderedKeys.push(key);
	});

	for (const entry of entries) {
		fs.copyFileSync(
			path.join(cacheDir, `${cardKey(entry, fingerprint)}.png`),
			path.join(outDir, `${entry.slug}.png`),
		);
	}

	// Evict whatever this build did not use (changed events, deleted events,
	// older templates, stray temp files).
	let evicted = 0;
	const used = new Set([...byKey.keys()].map((key) => `${key}.png`));
	for (const name of fs.readdirSync(cacheDir)) {
		if (!used.has(name)) {
			fs.rmSync(path.join(cacheDir, name), { force: true });
			evicted += 1;
		}
	}

	return {
		cards: entries.length,
		rendered: renderedKeys.length,
		reused,
		evicted,
		renderedKeys,
	};
}
