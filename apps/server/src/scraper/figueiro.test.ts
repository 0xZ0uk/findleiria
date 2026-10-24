import { describe, expect, test } from "bun:test";

import { isLeiriaDistrict } from "./district";
import {
	AGENDA_PATH,
	type DateParts,
	DEFAULT_VENUE,
	type DjevItem,
	dateFromHref,
	parseDjevDate,
	parseItems,
	SITE,
	scrape,
	toRawEvent,
} from "./figueiro";
import { toEpochInLisbon } from "./fingerprint";

/** 2026-09-12 12:00 UTC — the "now" every case below is judged against. */
const NOW = 1_789_214_400;

/** Real markup, trimmed: `div.djev_item` blocks exactly as the site serves them. */
const LISTING = `<!DOCTYPE html><html><body>
<div class="djev_items djev_clearfix">
	<div class="djev_item djev_clearfix ">
		<div class="djev_image_wrap">
			<a href="/index.php/listar-agenda-rss/details/2026-09-19/224-figueiro-colorido-caminhada-solidaria">
				<img class="djev_image" src="/media/djevents/images/224-figueiro-colorido/200x200-towidth-80-banner.jpg" alt="Figueiro Colorido" />
			</a>
		</div>
		<div class="djev_item_content">
			<h2 class="djev_item_title">
				<a href="/index.php/listar-agenda-rss/details/2026-09-19/224-figueiro-colorido-caminhada-solidaria"> Figueiró Colorido &quot;Caminhada Solidária&quot;</a>
			</h2>
			<h4 class="djev_time">
				<span class="djev_time_icon fa fa-clock-o"></span>
				<span class="djev_time_from"> Sábado, 19 setembro 2026 at 18:30 </span>
			</h4>
			<div class="djev_intro"> Caminhada solidária com partida do <b>Parque Municipal</b>. </div>
			<div class="djev_info">
				<a href="/index.php/listar-agenda-rss" class="djev_city">
					<i class="fa fa-map-marker"></i> Figueiró dos Vinhos </a>
				<a href="/index.php/listar-agenda-rss" class="djev_category" style=""> <span>Agenda</span> </a>
			</div>
		</div>
		<div class="djev_clear"></div>
	</div>
	<div class="djev_item djev_clearfix ">
		<div class="djev_image_wrap">
			<a href="/index.php/listar-agenda-rss/details/2026-04-01/201-concurso-de-fotografia-a-ver-figueiro-dos-vinhos-2026">
				<img class="djev_image" src="/media/djevents/images/201-concurso/200x200-towidth-80-cf.jpg" alt="concurso fotografia" />
			</a>
		</div>
		<div class="djev_item_content">
			<h2 class="djev_item_title">
				<a href="/index.php/listar-agenda-rss/details/2026-04-01/201-concurso-de-fotografia-a-ver-figueiro-dos-vinhos-2026"> Concurso de Fotografia "A VER Figueiró dos Vinhos" 2026</a>
			</h2>
			<h4 class="djev_time">
				<span class="djev_time_icon fa fa-clock-o"></span>
				<span class="djev_time_from"> Quarta, 1 abril 2026 </span>
				<span class="djev_time_to"> <span class="djev_time_sep">-</span> quarta, 30 setembro 2026 </span>
			</h4>
			<div class="djev_intro"> </div>
			<div class="djev_info">
				<a href="/index.php/listar-agenda-rss" class="djev_city">
					<i class="fa fa-map-marker"></i> Figueiró dos Vinhos </a>
				<a href="/index.php/listar-agenda-rss" class="djev_category" style=""> <span>Cultura</span> </a>
			</div>
		</div>
		<div class="djev_clear"></div>
	</div>
</div>
</body></html>`;

/** Listing links repeated, without the ISO date segment. */
const PLAIN_HREF = `${SITE}${AGENDA_PATH}`;

const item = (over: Partial<DjevItem> = {}): DjevItem => ({
	slug: "224-figueiro-colorido-caminhada-solidaria",
	href: `${SITE}/index.php/listar-agenda-rss/details/2026-09-19/224-figueiro-colorido-caminhada-solidaria`,
	title: "Figueiró Colorido",
	from: parseDjevDate("Sábado, 19 setembro 2026 at 18:30"),
	to: null,
	description: "Caminhada solidária com partida do Parque Municipal.",
	city: "Figueiró dos Vinhos",
	category: "Agenda",
	imageUrl: `${SITE}/media/djevents/images/224-figueiro-colorido/200x200.jpg`,
	...over,
});

describe("parseDjevDate", () => {
	test("reads the long-form date with a clock time", () => {
		expect(parseDjevDate("Sábado, 19 setembro 2026 at 18:30")).toEqual({
			year: 2026,
			month: 9,
			day: 19,
			hour: 18,
			minute: 30,
			hasTime: true,
		});
	});

	test("reads a day-precision date as hasTime=false", () => {
		expect(parseDjevDate("quinta, 31 dezembro 2026")).toEqual({
			year: 2026,
			month: 12,
			day: 31,
			hour: 0,
			minute: 0,
			hasTime: false,
		});
	});

	test("accepts the 24h form and abbreviations", () => {
		expect(parseDjevDate("1 janeiro 2025 às 10h00")?.hour).toBe(10);
		expect(parseDjevDate("1 jan. 2025")?.month).toBe(1);
		expect(parseDjevDate("3 de setembro de 2026")?.month).toBe(9);
	});

	test("refuses to invent a date from junk", () => {
		expect(parseDjevDate("Sábado")).toBeNull();
		expect(parseDjevDate("")).toBeNull();
		expect(parseDjevDate("32 janeiro 2026")).toBeNull();
		expect(parseDjevDate("19 setembro 2026 at 25:00")).toBeNull();
	});
});

describe("dateFromHref", () => {
	test("pulls the ISO date out of a details link", () => {
		expect(
			dateFromHref(
				"/index.php/listar-agenda-rss/details/2026-09-19/224-figueiro-colorido",
			),
		).toMatchObject({ year: 2026, month: 9, day: 19, hasTime: false });
	});

	test("returns null for a link without a dated detail path", () => {
		expect(dateFromHref(AGENDA_PATH)).toBeNull();
	});
});

describe("parseItems", () => {
	const items = parseItems(LISTING);

	test("reads every item block", () => {
		expect(items.length).toBe(2);
	});

	test("first item: title, link, intro, city, image, time", () => {
		const first = items[0] as DjevItem;
		expect(first.title).toBe('Figueiró Colorido "Caminhada Solidária"');
		expect(first.slug).toBe("224-figueiro-colorido-caminhada-solidaria");
		expect(first.city).toBe("Figueiró dos Vinhos");
		expect(first.category).toBe("Agenda");
		expect(first.description).toBe(
			"Caminhada solidária com partida do Parque Municipal.",
		);
		expect(first.imageUrl).toBe(
			`${SITE}/media/djevents/images/224-figueiro-colorido/200x200-towidth-80-banner.jpg`,
		);
		expect(first.from).toMatchObject({
			month: 9,
			day: 19,
			hour: 18,
			minute: 30,
		});
		expect(first.to).toBeNull();
	});

	test("second item: span keeps both ends, empty intro stays null", () => {
		const second = items[1] as DjevItem;
		expect(second.title).toBe(
			'Concurso de Fotografia "A VER Figueiró dos Vinhos" 2026',
		);
		expect(second.from).toMatchObject({ month: 4, day: 1, hasTime: false });
		expect(second.to).toMatchObject({ month: 9, day: 30, hasTime: false });
		expect(second.description).toBeNull();
		expect(second.category).toBe("Cultura");
	});
});

describe("toRawEvent", () => {
	test("timed single-day event lands on Lisbon wall-clock, no end when unknown", () => {
		const { raw, reason } = toRawEvent(item(), isLeiriaDistrict, NOW);
		expect(reason).toBeNull();
		// 18:30 Europe/Lisbon on 2026-09-19.
		expect(raw?.startAt).toBe(1_789_839_000);
		expect(raw?.endAt).toBeNull();
		expect(raw?.dateText).toBeNull();
		expect(raw?.venueName).toBe("Figueiró dos Vinhos");
		expect(raw?.city).toBe("Figueiró dos Vinhos");
	});

	test("day-precision row closes at end of its own day", () => {
		const { raw } = toRawEvent(
			item({ from: parseDjevDate("Sábado, 19 setembro 2026") }),
			isLeiriaDistrict,
			NOW,
		);
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 19, 23, 59));
	});

	test("a span ends at the end of its last day", () => {
		const { raw } = toRawEvent(
			item({
				from: parseDjevDate("Quarta, 1 abril 2026"),
				to: parseDjevDate("quarta, 30 setembro 2026"),
			}),
			isLeiriaDistrict,
			NOW,
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 4, 1));
		expect(raw?.endAt).toBe(toEpochInLisbon(2026, 9, 30, 23, 59));
	});

	test("falls back to the ISO date in the link when the chip is unreadable", () => {
		const { raw } = toRawEvent(
			item({ from: parseDjevDate("data a anunciar") }),
			isLeiriaDistrict,
			NOW,
		);
		expect(raw?.startAt).toBe(toEpochInLisbon(2026, 9, 19));
	});

	test("drops an already-finished event", () => {
		const { raw, reason } = toRawEvent(
			item({ from: parseDjevDate("Quinta, 10 setembro 2026") }),
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("past");
	});

	test("an impossible calendar date reports invalidDate instead of throwing", () => {
		const bad = {
			...(parseDjevDate("Sábado, 19 setembro 2026 at 18:30") as DateParts),
			day: 31,
		};
		const start = toRawEvent(item({ from: bad }), isLeiriaDistrict, NOW);
		expect(start).toEqual({ raw: null, reason: "invalidDate" });
		const end = toRawEvent(item({ to: bad }), isLeiriaDistrict, NOW);
		expect(end).toEqual({ raw: null, reason: "invalidDate" });
	});

	test("drops a row that is neither dated nor link-dated", () => {
		const { raw, reason } = toRawEvent(
			item({ from: null, href: PLAIN_HREF }),
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("undated");
	});

	test("gate: an out-of-district city is dropped, not relocated", () => {
		const { raw, reason } = toRawEvent(
			item({ city: "Lisboa" }),
			isLeiriaDistrict,
			NOW,
		);
		expect(raw).toBeNull();
		expect(reason).toBe("outOfDistrict");
	});

	test("a row with no city keeps the concelho fallback", () => {
		const { raw } = toRawEvent(item({ city: null }), isLeiriaDistrict, NOW);
		expect(raw?.city).toBe(DEFAULT_VENUE);
		expect(raw?.venueName).toBe(DEFAULT_VENUE);
	});

	test("the section label is not a category", () => {
		expect(toRawEvent(item(), isLeiriaDistrict, NOW).raw?.categories).toEqual(
			[],
		);
		expect(
			toRawEvent(item({ category: "Cultura" }), isLeiriaDistrict, NOW).raw
				?.categories,
		).toEqual(["Cultura"]);
	});
});

describe("scrape", () => {
	test("one listing request, district-gated events", async () => {
		const urls: string[] = [];
		const result = await scrape(
			{
				fetchText: async (url) => {
					urls.push(url);
					return LISTING;
				},
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(urls).toEqual([`${SITE}${AGENDA_PATH}`]);
		expect(result.pagesFetched).toBe(1);
		expect(result.discovered).toBe(2);
		expect(result.events.length).toBe(2);
		expect(result.events.map((e) => e.slug)).toEqual([
			"224-figueiro-colorido-caminhada-solidaria",
			"201-concurso-de-fotografia-a-ver-figueiro-dos-vinhos-2026",
		]);
		expect(result.events[0]?.url).toBe(
			`${SITE}/index.php/listar-agenda-rss/details/2026-09-19/224-figueiro-colorido-caminhada-solidaria`,
		);
		expect(result.droppedPast).toBe(0);
		expect(result.droppedOutOfDistrict).toBe(0);
		expect(result.failures).toBe(0);
	});

	test("an impossible date skips only that item and counts a failure", async () => {
		const result = await scrape(
			{
				fetchText: async () =>
					LISTING.replace(
						"Sábado, 19 setembro 2026 at 18:30",
						"Sábado, 31 setembro 2026 at 18:30",
					),
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(result.events.length).toBe(1);
		expect(result.events[0]?.slug).toContain("concurso");
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("impossible date");
	});

	test("a failed fetch is reported, never fatal", async () => {
		const result = await scrape(
			{
				fetchText: async () => {
					throw new Error("boom");
				},
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(result.events).toEqual([]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("boom");
		expect(result.pagesFetched).toBe(0);
	});

	test("S7: a listing that parses to zero items is a counted failure", async () => {
		const result = await scrape(
			{
				fetchText: async () => "<html><body>Just a moment...</body></html>",
				sleep: async () => {},
				now: NOW,
			},
			isLeiriaDistrict,
		);
		expect(result.events).toEqual([]);
		expect(result.failures).toBe(1);
		expect(result.firstError).toContain("zero items");
		expect(result.pagesFetched).toBe(1);
	});
});
