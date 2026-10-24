import { describe, expect, test } from "bun:test";

import {
	findJsonLdEvent,
	flattenJsonLd,
	isEventNode,
	jsonLdBlocks,
	jsonLdTypes,
} from "./jsonld";

const page = (...blocks: unknown[]) =>
	`<html><head>${blocks
		.map(
			(b) =>
				`<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`,
		)
		.join("\n")}</head></html>`;

describe("jsonLdBlocks", () => {
	test("parses every block and skips malformed ones", () => {
		const html = page({ a: 1 }, "{ not json", { b: 2 });
		expect(jsonLdBlocks(html)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("tolerates extra attributes and single quotes", () => {
		const html = `<script id="x" type='application/ld+json' data-n="1">{"a":1}</script>`;
		expect(jsonLdBlocks(html)).toEqual([{ a: 1 }]);
	});

	test("ignores other script types", () => {
		expect(
			jsonLdBlocks(`<script type="text/javascript">{"a":1}</script>`),
		).toEqual([]);
	});
});

describe("flattenJsonLd", () => {
	test("bare object", () => {
		expect(flattenJsonLd({ "@type": "Event", name: "a" })).toHaveLength(1);
	});

	test("array root", () => {
		const nodes = flattenJsonLd([{ "@type": "Event" }, { "@type": "Place" }]);
		expect(nodes.map((n) => n["@type"])).toEqual(["Event", "Place"]);
	});

	test("@graph members replace the untyped container", () => {
		const nodes = flattenJsonLd({
			"@context": "https://schema.org",
			"@graph": [{ "@type": "Organization" }, { "@type": "MusicEvent" }],
		});
		expect(nodes.map((n) => n["@type"])).toEqual([
			"Organization",
			"MusicEvent",
		]);
	});

	test("nested arrays and a graph inside an array", () => {
		const nodes = flattenJsonLd([
			[{ "@type": "A" }, [{ "@type": "B" }]],
			{ "@graph": [{ "@type": "C" }] },
		]);
		expect(nodes.map((n) => n["@type"])).toEqual(["A", "B", "C"]);
	});

	test("a typed container is kept before its members", () => {
		const nodes = flattenJsonLd({
			"@type": "WebPage",
			"@graph": [{ "@type": "Event" }],
		});
		expect(nodes.map((n) => n["@type"])).toEqual(["WebPage", "Event"]);
	});

	test("ignores scalars and null", () => {
		expect(flattenJsonLd(null)).toEqual([]);
		expect(flattenJsonLd("x")).toEqual([]);
		expect(flattenJsonLd([1, null, "a"])).toEqual([]);
	});
});

describe("jsonLdTypes / isEventNode", () => {
	test("string or array @type, schema.org URL prefix stripped", () => {
		expect(jsonLdTypes({ "@type": "Event" })).toEqual(["Event"]);
		expect(jsonLdTypes({ "@type": ["Thing", "MusicEvent"] })).toEqual([
			"Thing",
			"MusicEvent",
		]);
		expect(jsonLdTypes({ "@type": "https://schema.org/TheaterEvent" })).toEqual(
			["TheaterEvent"],
		);
		expect(jsonLdTypes({})).toEqual([]);
	});

	test("accepts Event, any *Event subtype and Festival", () => {
		for (const t of [
			"Event",
			"MusicEvent",
			"TheaterEvent",
			"LiteraryEvent",
			"EducationEvent",
			"Festival",
		]) {
			expect(isEventNode({ "@type": t })).toBe(true);
		}
		expect(isEventNode({ "@type": ["Place", "ExhibitionEvent"] })).toBe(true);
	});

	test("rejects non-events", () => {
		for (const t of [
			"Organization",
			"Place",
			"BreadcrumbList",
			"ItemList",
			"MusicGroup",
			"EventSeriesX",
		]) {
			expect(isEventNode({ "@type": t })).toBe(false);
		}
		expect(isEventNode({ name: "no type" })).toBe(false);
		expect(isEventNode({ "@type": 5 })).toBe(false);
	});
});

describe("findJsonLdEvent", () => {
	test("plain Event root", () => {
		const ev = findJsonLdEvent(page({ "@type": "Event", name: "A" }));
		expect(ev?.name).toBe("A");
	});

	test("MusicEvent root (an exact-Event scanner would miss it)", () => {
		const ev = findJsonLdEvent(page({ "@type": "MusicEvent", name: "M" }));
		expect(ev?.name).toBe("M");
	});

	test("array root", () => {
		const ev = findJsonLdEvent(
			page([
				{ "@type": "Organization" },
				{ "@type": "TheaterEvent", name: "T" },
			]),
		);
		expect(ev?.name).toBe("T");
	});

	test("@graph root with the event not first", () => {
		const ev = findJsonLdEvent(
			page({
				"@graph": [
					{ "@type": "BreadcrumbList" },
					{ "@type": ["Thing", "Festival"], name: "F" },
				],
			}),
		);
		expect(ev?.name).toBe("F");
	});

	test("event found in a later block after a non-event and a malformed block", () => {
		const ev = findJsonLdEvent(
			page({ "@type": "Organization" }, "{oops", {
				"@type": "Event",
				name: "L",
			}),
		);
		expect(ev?.name).toBe("L");
	});

	test("first matching node wins", () => {
		const ev = findJsonLdEvent(
			page(
				{ "@type": "Event", name: "1st" },
				{ "@type": "Event", name: "2nd" },
			),
		);
		expect(ev?.name).toBe("1st");
	});

	test("null when there is no event or no JSON-LD", () => {
		expect(findJsonLdEvent(page({ "@type": "Organization" }))).toBeNull();
		expect(findJsonLdEvent("<html></html>")).toBeNull();
		expect(findJsonLdEvent(page("{bad"))).toBeNull();
	});

	test("accept option replaces the type test (first-block / startDate semantics)", () => {
		const html = page({ "@type": "Organization", name: "Org", startDate: "x" });
		expect(findJsonLdEvent(html)).toBeNull();
		const any = findJsonLdEvent(html, { accept: () => true });
		expect(any?.name).toBe("Org");
		const byDate = findJsonLdEvent(
			page({
				"@graph": [{ name: "no" }, { name: "yes", startDate: "2026-01-01" }],
			}),
			{ accept: (n) => typeof n.startDate === "string" },
		);
		expect(byDate?.name).toBe("yes");
	});
});
