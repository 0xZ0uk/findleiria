// bun test for the OG card cache: key stability, reuse, eviction, cold start,
// bounded concurrency. The renderer is a stub; og-card.test.mjs covers the real one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildCards,
	cardKey,
	liveCardKeys,
	mapPool,
	normalizeCardInput,
	templateFingerprint,
} from "./og-cache.mjs";

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("fake-card"),
]);

let root;
let cacheDir;
let outDir;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "og-cache-"));
	// Not created: a cold build must create the cache directory itself.
	cacheDir = path.join(root, "node_modules", ".cache", "og-cards");
	outDir = path.join(root, "dist", "og");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function counting() {
	const calls = [];
	const render = async (input) => {
		calls.push(input);
		return Buffer.concat([PNG, Buffer.from(input.title)]);
	};
	return { calls, render };
}

const event = (slug, extra = {}) => ({
	slug,
	title: `Evento ${slug}`,
	dayLabel: "12 set 2026",
	venueLabel: "Teatro",
	...extra,
});

const run = (entries, render, fingerprint = "fp1") =>
	buildCards({ entries, cacheDir, outDir, fingerprint, render });

test("the key follows exactly the drawn text and the template", () => {
	const base = event("a");
	const key = cardKey(base, "fp1");

	// Not drawn: the slug (and anything else on the event) is not an input.
	expect(cardKey({ ...base, slug: "b", description: "x" }, "fp1")).toBe(key);
	// The renderer's own fallbacks and trimming do not split keys.
	expect(cardKey({ ...base, title: `  ${base.title} ` }, "fp1")).toBe(key);
	expect(cardKey({ ...base, venueLabel: "" }, "fp1")).toBe(
		cardKey({ ...base, venueLabel: undefined }, "fp1"),
	);
	expect(normalizeCardInput({})).toEqual({
		title: "Evento",
		dayLabel: "",
		venueLabel: "Leiria",
	});

	// Drawn: each of these changes the image.
	expect(cardKey({ ...base, title: "Outro" }, "fp1")).not.toBe(key);
	expect(cardKey({ ...base, dayLabel: "13 set 2026" }, "fp1")).not.toBe(key);
	expect(cardKey({ ...base, venueLabel: "Cine" }, "fp1")).not.toBe(key);
	expect(cardKey(base, "fp2")).not.toBe(key);
});

test("liveCardKeys lists each distinct key once", () => {
	const same = { title: "Mesmo", dayLabel: "1 jan 2027", venueLabel: "Sala" };
	const keys = liveCardKeys(
		[event("a", same), event("b", same), event("c")],
		"fp1",
	);
	expect(keys).toEqual([
		cardKey(event("a", same), "fp1"),
		cardKey(event("c"), "fp1"),
	]);
});

test("the template fingerprint changes when a template file does", () => {
	const file = path.join(root, "template.mjs");
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(file, "v1");
	const one = templateFingerprint([file]);
	expect(templateFingerprint([file])).toBe(one);
	fs.writeFileSync(file, "v2");
	expect(templateFingerprint([file])).not.toBe(one);
});

test("the site host is part of the template fingerprint and so of every key", () => {
	const file = path.join(root, "template.js");
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(file, "v1");
	const here = templateFingerprint([file], "findleiria.pt");
	expect(templateFingerprint([file], "findleiria.pt")).toBe(here);
	expect(templateFingerprint([file], "example.workers.dev")).not.toBe(here);
	expect(templateFingerprint([file])).not.toBe(here);

	const card = { title: "Fado", dayLabel: "1 jan 2027", venueLabel: "Teatro" };
	expect(cardKey(card, here)).not.toBe(
		cardKey(card, templateFingerprint([file], "example.workers.dev")),
	);
});

test("a cold build creates the cache and renders every card", async () => {
	const { calls, render } = counting();
	const stats = await run([event("a"), event("b")], render);

	expect(stats).toMatchObject({
		cards: 2,
		rendered: 2,
		reused: 0,
		evicted: 0,
	});
	// The rendered keys are the live keys: what a remote store must be given.
	expect(stats.renderedKeys.sort()).toEqual(
		liveCardKeys([event("a"), event("b")], "fp1").sort(),
	);
	expect(calls).toHaveLength(2);
	expect(fs.readdirSync(outDir).sort()).toEqual(["a.png", "b.png"]);
	expect(fs.readdirSync(cacheDir)).toHaveLength(2);
});

test("a warm build reuses unchanged cards and renders only the changed one", async () => {
	await run([event("a"), event("b")], counting().render);

	const { calls, render } = counting();
	const stats = await run(
		[event("a"), event("b", { title: "Título novo" })],
		render,
	);

	expect(stats).toMatchObject({ rendered: 1, reused: 1, evicted: 1 });
	expect(stats.renderedKeys).toEqual([
		cardKey(event("b", { title: "Título novo" }), "fp1"),
	]);
	expect(calls.map((c) => c.title)).toEqual(["Título novo"]);
	// The reused card is byte-identical to what the cold build wrote.
	expect(fs.readFileSync(path.join(outDir, "a.png"))).toEqual(
		Buffer.concat([PNG, Buffer.from("Evento a")]),
	);
	expect(fs.readFileSync(path.join(outDir, "b.png")).toString()).toContain(
		"Título novo",
	);
});

test("evicts cards for events that are gone, and stray temp files", async () => {
	await run([event("a"), event("b"), event("c")], counting().render);
	fs.writeFileSync(path.join(cacheDir, "half.png.123.tmp"), "x");

	const stats = await run([event("a")], counting().render);

	expect(stats).toMatchObject({ rendered: 0, reused: 1, evicted: 3 });
	expect(fs.readdirSync(cacheDir)).toHaveLength(1);
});

test("a template change re-renders everything and evicts the old cards", async () => {
	await run([event("a"), event("b")], counting().render);
	const { calls, render } = counting();
	const stats = await run([event("a"), event("b")], render, "fp2");

	expect(stats).toMatchObject({
		cards: 2,
		rendered: 2,
		reused: 0,
		evicted: 2,
	});
	expect(calls).toHaveLength(2);
});

test("a corrupt cache entry is re-rendered, not served", async () => {
	await run([event("a")], counting().render);
	const [name] = fs.readdirSync(cacheDir);
	fs.writeFileSync(path.join(cacheDir, name), "not a png");

	const { calls, render } = counting();
	const stats = await run([event("a")], render);

	expect(stats.rendered).toBe(1);
	expect(calls).toHaveLength(1);
	expect(fs.readFileSync(path.join(outDir, "a.png")).subarray(1, 4)).toEqual(
		Buffer.from("PNG"),
	);
});

test("events with identical card text share one render but each get a file", async () => {
	const { calls, render } = counting();
	const same = { title: "Mesmo", dayLabel: "1 jan 2027", venueLabel: "Sala" };
	const stats = await run(
		[event("a", same), event("a-2", same), event("a-3", same)],
		render,
	);

	expect(calls).toHaveLength(1);
	expect(stats).toMatchObject({ cards: 3, rendered: 1 });
	expect(fs.readdirSync(outDir).sort()).toEqual([
		"a-2.png",
		"a-3.png",
		"a.png",
	]);
});

test("a failing render rejects and leaves no half-written card", async () => {
	const render = async () => {
		throw new Error("boom");
	};
	await expect(run([event("a")], render)).rejects.toThrow("boom");
	expect(fs.readdirSync(cacheDir)).toEqual([]);
});

test("mapPool never has more than `limit` tasks in flight and keeps order", async () => {
	let inFlight = 0;
	let peak = 0;
	const out = await mapPool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 5));
		inFlight -= 1;
		return n * 2;
	});

	expect(peak).toBe(4);
	expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
	expect(await mapPool([], 4, async () => 1)).toEqual([]);
});
