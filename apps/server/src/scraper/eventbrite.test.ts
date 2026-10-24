import { describe, expect, test } from "bun:test";

import { LISTING_URL, scrape, toRawEvent } from "./eventbrite";

const ev = (eid: string, startDate: string, endDate?: string) => ({
	eid,
	name: `Evento ${eid}`,
	start_date: startDate,
	start_time: "21:30",
	end_date: endDate,
	end_time: endDate ? "23:30" : undefined,
	primary_venue: { name: "Teatro", address: { city: "Leiria" } },
});

const page = (events: unknown[]) =>
	`<script>window.__SERVER_DATA__ = ${JSON.stringify({ buckets: [{ events }] })};</script>`;

describe("impossible dates (S2)", () => {
	test("toRawEvent returns null for 2026-02-30, never throws", () => {
		expect(toRawEvent(ev("1", "2026-02-30"))).toBeNull();
		expect(toRawEvent(ev("2", "2026-10-01", "2026-02-30"))).toBeNull();
		expect(toRawEvent(ev("3", "2026-10-01"))?.slug).toBe("eb-3");
	});

	test("a bad item is skipped and counted; later items and pages still parse", async () => {
		const pages: Record<string, string> = {
			[LISTING_URL]: page([ev("1", "2026-10-01"), ev("2", "2026-02-30")]),
			[`${LISTING_URL}?page=2`]: page([ev("3", "2026-10-03")]),
		};
		const result = await scrape({
			fetchText: async (url) => pages[url] ?? page([]),
			sleep: async () => {},
		});
		expect(result.events.map((e) => e.slug).sort()).toEqual(["eb-1", "eb-3"]);
		expect(result.failures).toBe(1);
		expect(result.pagesFetched).toBeGreaterThanOrEqual(2);
	});
});
