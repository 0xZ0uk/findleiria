import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { must } from "../test-helpers";
import { isLeiriaDistrict } from "./district";
import {
	parseDetailLd,
	parseListingLinks,
	REGION_URL,
	scrape,
	slugFor,
	toRawEvent,
} from "./shotgun";

const read = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8");

const cityHtml = read("shotgun-city.html");
const detailHtml = read("shotgun-detail.html");

describe("parseListingLinks (region listing fixture)", () => {
	test("collects every event slug, deduped", () => {
		const slugs = parseListingLinks(cityHtml);
		expect(slugs.length).toBe(14);
		expect(slugs).toContain("last-friday-night-praia-do-pedrogao");
		expect(slugs).toContain("darkroom-sunset-praia-nova-beach-club");
	});
});

describe("parseDetailLd (MusicEvent JSON-LD)", () => {
	test("resolves the Leiria-district event (Pedrogão)", () => {
		const ld = parseDetailLd(detailHtml);
		expect(ld).not.toBeNull();
		expect(ld?.name).toBe("Last Friday Night · Praia Do Pedrógão");
		expect(ld?.startDate).toBe("2026-09-04T21:00:00.000Z");
		expect(ld?.location?.name).toBe("Praia Nova Beach Club");
		expect(ld?.location?.address?.addressLocality).toBe("Pedrogão");
	});

	test("ignores Brand/WebSite/BreadcrumbList blocks", () => {
		const html = `<html><script type="application/ld+json">${JSON.stringify({ "@type": "Brand", name: "Shotgun" })}</script>
		<script type="application/ld+json">${JSON.stringify({ "@type": "BreadcrumbList", itemListElement: [] })}</script></html>`;
		expect(parseDetailLd(html)).toBeNull();
	});
});

describe("toRawEvent", () => {
	test("maps the Pedrogão event with UTC epoch and image", () => {
		const ld = must(parseDetailLd(detailHtml));
		const raw = must(toRawEvent("last-friday-night-praia-do-pedrogao", ld));
		expect(raw.slug).toBe("sg-last-friday-night-praia-do-pedrogao");
		expect(raw.title).toBe("Last Friday Night · Praia Do Pedrógão");
		// 2026-09-04T21:00:00.000Z = 1788555600
		expect(raw.startAt).toBe(1788555600);
		expect(raw.city).toBe("Pedrogão");
		expect(raw.venueName).toBe("Praia Nova Beach Club");
		// SLICE_6: platform names are no longer injected as categories.
		expect(raw.categories).toEqual([]);
		expect(raw.url).toBe(
			"https://shotgun.live/en/events/last-friday-night-praia-do-pedrogao",
		);
	});

	test("null when JSON-LD has no name or start", () => {
		expect(toRawEvent("x", { name: "x", "@type": "Event" })).toBeNull();
	});
});

describe("S7 scrape: broken listing is a failure", () => {
	test("a Vercel checkpoint page served with 200 is counted, not a quiet day", async () => {
		const result = await scrape({
			fetchText: async () =>
				"<html><head><title>Vercel Security Checkpoint</title></head><body>Verifying your browser...</body></html>",
			sleep: async () => {},
		});
		expect(result.events).toEqual([]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("zero events");
		expect(result.pagesFetched).toBe(1);
	});

	test("a healthy listing is not flagged", async () => {
		const result = await scrape({
			fetchText: async (url) => (url === REGION_URL ? cityHtml : detailHtml),
			sleep: async () => {},
		});
		expect(result.failures).toBe(0);
		expect(result.listedSlugs.length).toBe(14);
	});
});

describe("S13 scrape(): happy path and failure paths", () => {
	const slugs = parseListingLinks(cityHtml);
	const BAD = slugs[3] ?? "";

	function run(
		overrides: {
			failOn?: string;
			inScope?: (c: string | null | undefined) => boolean;
		} = {},
	) {
		const fetched: string[] = [];
		const promise = scrape(
			{
				fetchText: async (url) => {
					fetched.push(url);
					if (url === REGION_URL) {
						return cityHtml;
					}
					if (overrides.failOn && url.endsWith(`/${overrides.failOn}`)) {
						throw new Error(`GET ${url} -> HTTP 429`);
					}
					return detailHtml;
				},
				sleep: async () => {},
			},
			overrides.inScope ?? (() => true),
		);
		return { promise, fetched };
	}

	test("one detail fetch per listed slug; every parsed event is emitted", async () => {
		const { promise, fetched } = run();
		const res = await promise;
		expect(slugs).toHaveLength(14);
		expect(res.failures).toBe(0);
		expect(res.pagesFetched).toBe(15);
		expect(fetched).toHaveLength(15);
		expect(res.events.map((e) => e.slug).sort()).toEqual(
			slugs.map(slugFor).sort(),
		);
		expect(res.events.every((e) => e.startAt === 1788555600)).toBe(true);
	});

	test("a detail fetch that throws is counted; the other events still come out", async () => {
		const { promise } = run({ failOn: BAD });
		const res = await promise;
		expect(res.failures).toBe(1);
		expect(res.firstError).toContain(BAD);
		expect(res.firstError).toContain("429");
		expect(res.events).toHaveLength(13);
		expect(res.events.some((e) => e.slug === slugFor(BAD))).toBe(false);
		expect(res.pagesFetched).toBe(14);
	});

	test("the district gate runs on the JSON-LD locality: Pedrogão passes, others do not", async () => {
		const inDistrict = await run({ inScope: isLeiriaDistrict }).promise;
		expect(inDistrict.events).toHaveLength(14);
		const outside = await run({ inScope: (c) => c === "Lisboa" }).promise;
		expect(outside.events).toEqual([]);
		expect(outside.failures).toBe(0);
	});

	test("a detail page with no event JSON-LD is dropped quietly (not a failure)", async () => {
		const res = await scrape({
			fetchText: async (url) =>
				url === REGION_URL ? cityHtml : "<html>sem json-ld</html>",
			sleep: async () => {},
		});
		expect(res.events).toEqual([]);
		expect(res.failures).toBe(0);
	});
});

describe("slugFor", () => {
	test("prefixes sg-", () => {
		expect(slugFor("abc")).toBe("sg-abc");
	});
});
