import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { schema } from "@events-tracker/db/client";

import {
	createTestDb,
	DAY,
	event,
	insertEvents,
	NOW,
	type TestDb,
} from "../test-db";
import {
	type Db,
	eventBySlug,
	eventDirectory,
	eventStats,
	eventsBySlugs,
	listEvents,
	listInput,
	undatedEvents,
	WINDOW_MAX,
} from "./events";

/**
 * The window cap is a safety valve, not a page size.
 *
 * When it drops below what a 90-day window actually holds, the furthest-future
 * events disappear with no error and no failed request — the page simply shows
 * fewer days than the data has. It sat at 500 while the live window held 501.
 */
describe("listInput", () => {
	test("defaults to the whole window rather than a page", () => {
		expect(listInput.parse({}).limit).toBe(WINDOW_MAX);
	});

	test("accepts the limit the agenda page asks for", () => {
		expect(listInput.parse({ limit: WINDOW_MAX }).limit).toBe(WINDOW_MAX);
	});

	/**
	 * Guards the headroom: the window grows ~120 events/week, so a cap that
	 * leaves room for only today's 501 rows would slip back into silent
	 * truncation within months.
	 */
	test("leaves headroom above a full 90-day window", () => {
		expect(WINDOW_MAX).toBeGreaterThanOrEqual(1000);
	});

	test("is still a cap — an unbounded fetch is not the fix", () => {
		expect(listInput.safeParse({ limit: WINDOW_MAX + 1 }).success).toBe(false);
		expect(listInput.safeParse({ limit: 0 }).success).toBe(false);
	});
});

/**
 * Everything below runs the real SQL against a libSQL file with the committed
 * migrations applied. The undated rows are inserted so that id order and
 * start order disagree, which makes the `desc(id)` ordering observable.
 */
let t: TestDb;
let db: Db;

const list = (input: Parameters<typeof listInput.parse>[0] = {}) =>
	listEvents(db, listInput.parse(input));
const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug);

beforeAll(async () => {
	t = await createTestDb("findleiria-events-");
	db = t.db;

	await db.insert(schema.venues).values([
		{
			id: 1,
			name: "Teatro José Lúcio da Silva",
			slug: "teatro-jose-lucio-da-silva",
			city: "Leiria",
			lat: 39.7467,
			lng: -8.8039,
			scope: "venue",
		},
		{
			id: 2,
			name: "Marinha Grande",
			slug: "marinha-grande",
			city: "Marinha Grande",
			scope: "concelho",
		},
	]);

	await insertEvents(db, [
		event(1, "passado", NOW - 30 * DAY),
		event(2, "jazz", NOW + DAY, {
			title: "Jazz ao Fim da Tarde",
			is_free: true,
		}),
		event(3, "cinema", NOW + 3 * DAY, {
			venue_id: 2,
			categories: ["Cinema"],
			is_free: false,
			featured_at: NOW - 3600,
		}),
		// Two sessions of one show on the same Lisbon day: one agenda row.
		event(4, "peca-18h", NOW + 5 * DAY, {
			title: "Peça",
			categories: ["Teatro"],
		}),
		event(5, "peca-21h", NOW + 5 * DAY + 3 * 3600, {
			title: "Peça",
			categories: ["Teatro"],
			is_free: true,
			featured_at: NOW - 60,
		}),
		// No venue at all: the join must keep the row, with null place fields.
		event(6, "sem-sitio", NOW + 6 * DAY, {
			venue_id: null,
			categories: ["Música", "Teatro"],
		}),
		// Undated: id 8 is the older start, so desc(id) differs from start order.
		event(7, "brevemente", NOW, { date_text: "Em breve", venue_id: 2 }),
		event(8, "a-anunciar", NOW - 5 * DAY, { date_text: "A anunciar" }),
	]);

	await db.insert(schema.scrapeRuns).values([
		{ source: "leiriagenda", started_at: NOW - 3 * DAY, items_found: 9 },
		{
			source: "leiriagenda",
			started_at: NOW - 3600,
			items_found: 12,
			items_new: 4,
		},
		{ source: "leiriagenda", started_at: NOW - 2 * DAY, items_found: 10 },
	]);
});

afterAll(() => t.cleanup());

describe("listEvents: window and undated", () => {
	test("returns dated events oldest first, merged, undated excluded", async () => {
		expect(slugs(await list())).toEqual([
			"passado",
			"jazz",
			"cinema",
			"peca-18h",
			"sem-sitio",
		]);
	});

	test("dateFrom and dateTo are inclusive bounds on start_at", async () => {
		const from = await list({ dateFrom: NOW + DAY });
		expect(slugs(from)).toEqual(["jazz", "cinema", "peca-18h", "sem-sitio"]);

		const to = await list({ dateTo: NOW + 3 * DAY });
		expect(slugs(to)).toEqual(["passado", "jazz", "cinema"]);

		const both = await list({ dateFrom: NOW + DAY, dateTo: NOW + 3 * DAY });
		expect(slugs(both)).toEqual(["jazz", "cinema"]);
	});

	test("includeUndated adds the announcements into the same list", async () => {
		const rows = await list({ includeUndated: true });
		expect(slugs(rows)).toContain("brevemente");
		expect(slugs(rows)).toContain("a-anunciar");
		expect(rows).toHaveLength(7);
		expect(rows.find((r) => r.slug === "brevemente")?.dateText).toBe(
			"Em breve",
		);
	});
});

describe("listEvents: filters", () => {
	test("venueSlug keeps only that venue's events", async () => {
		const rows = await list({ venueSlug: "marinha-grande" });
		expect(slugs(rows)).toEqual(["cinema"]);
		expect(await list({ venueSlug: "nao-existe" })).toEqual([]);
	});

	test("city keeps only events at venues in that city", async () => {
		const rows = await list({ city: "Leiria" });
		expect(slugs(rows)).toEqual(["passado", "jazz", "peca-18h"]);
	});

	test("filters combine", async () => {
		const rows = await list({
			city: "Leiria",
			dateFrom: NOW,
			dateTo: NOW + 2 * DAY,
		});
		expect(slugs(rows)).toEqual(["jazz"]);
	});

	test("an unplaced venue ships null coordinates, never zero", async () => {
		const rows = await list();
		const sem = rows.find((r) => r.slug === "sem-sitio");
		expect(sem).toMatchObject({
			venueId: null,
			venueName: null,
			venueLat: null,
			venueLng: null,
			venueScope: null,
		});

		const cinema = rows.find((r) => r.slug === "cinema");
		expect(cinema).toMatchObject({
			venueLat: null,
			venueLng: null,
			venueScope: "concelho",
		});

		const jazz = rows.find((r) => r.slug === "jazz");
		expect(jazz).toMatchObject({
			venueLat: 39.7467,
			venueLng: -8.8039,
			venueScope: "venue",
		});
	});
});

describe("listEvents: merging and slicing", () => {
	test("folds same-day sessions into one row carrying every start", async () => {
		const peca = (await list()).find((r) => r.title === "Peça");
		expect(peca?.slug).toBe("peca-18h");
		expect(peca?.sessionStarts).toEqual([
			NOW + 5 * DAY,
			NOW + 5 * DAY + 3 * 3600,
		]);
	});

	/**
	 * Within the dated rows from `jazz` on there are 5 raw rows but 4 events. A
	 * LIMIT applied in SQL would return 3 events here; slicing after the merge
	 * returns the full 4 asked for.
	 */
	test("merges before the limit slice", async () => {
		const rows = await list({ dateFrom: NOW, limit: 4 });
		expect(slugs(rows)).toEqual(["jazz", "cinema", "peca-18h", "sem-sitio"]);
	});

	test("offset pages over merged events, never splitting a group", async () => {
		const first = await list({ dateFrom: NOW, limit: 2 });
		const second = await list({ dateFrom: NOW, limit: 2, offset: 2 });
		expect(slugs(first)).toEqual(["jazz", "cinema"]);
		expect(slugs(second)).toEqual(["peca-18h", "sem-sitio"]);
		expect(second[0]?.sessionStarts).toHaveLength(2);
	});

	test("never carries a description or update stamp in the list payload", async () => {
		for (const row of await list()) {
			expect("description" in row).toBe(false);
			expect("updatedAt" in row).toBe(false);
		}
	});
});

describe("undatedEvents", () => {
	test("lists only announcements, newest id first", async () => {
		const rows = await undatedEvents(db);
		expect(slugs(rows)).toEqual(["a-anunciar", "brevemente"]);
		expect(rows[0]?.dateText).toBe("A anunciar");
	});
});

describe("eventStats", () => {
	test("counts rows and reports the most recent run", async () => {
		expect(await eventStats(db)).toEqual({
			totalEvents: 8,
			totalVenues: 2,
			lastRunAt: NOW - 3600,
			lastRunFound: 12,
			lastRunNew: 4,
		});
	});

	test("is zero and null on an empty database", async () => {
		const empty = await createTestDb("findleiria-empty-");
		try {
			expect(await eventStats(empty.db)).toEqual({
				totalEvents: 0,
				totalVenues: 0,
				lastRunAt: null,
				lastRunFound: null,
				lastRunNew: null,
			});
			expect(await eventDirectory(empty.db)).toEqual([]);
			expect(await undatedEvents(empty.db)).toEqual([]);
		} finally {
			empty.cleanup();
		}
	});
});

describe("isFree and featuredAt", () => {
	const byslug = (rows: { slug: string }[], slug: string) =>
		rows.find((r) => r.slug === slug);

	test("the agenda carries both, null when unknown or not picked", async () => {
		const rows = await list();
		expect(byslug(rows, "jazz")).toMatchObject({
			isFree: true,
			featuredAt: null,
		});
		expect(byslug(rows, "cinema")).toMatchObject({
			isFree: false,
			featuredAt: NOW - 3600,
		});
		expect(byslug(rows, "sem-sitio")).toMatchObject({
			isFree: null,
			featuredAt: null,
		});
	});

	test("a merged show takes the flag and the pick from a later session", async () => {
		const rows = await list();
		expect(byslug(rows, "peca-18h")).toMatchObject({
			isFree: true,
			featuredAt: NOW - 60,
		});
		expect(byslug(rows, "peca-21h")).toBeUndefined();
	});

	test("the event page, the saved list, the directory and undated rows carry them too", async () => {
		expect(await eventBySlug(db, "cinema")).toMatchObject({
			isFree: false,
			featuredAt: NOW - 3600,
		});
		expect(
			byslug(await eventsBySlugs(db, ["jazz", "cinema"]), "jazz"),
		).toMatchObject({ isFree: true, featuredAt: null });
		expect(byslug(await eventDirectory(db), "peca-21h")).toMatchObject({
			isFree: true,
			featuredAt: NOW - 60,
		});
		expect(byslug(await undatedEvents(db), "brevemente")).toMatchObject({
			isFree: null,
			featuredAt: null,
		});
	});
});

describe("eventBySlug", () => {
	test("returns the description and the update stamp the page needs", async () => {
		const found = await eventBySlug(db, "jazz");

		expect(found).toMatchObject({
			slug: "jazz",
			title: "Jazz ao Fim da Tarde",
			description: "Descrição de jazz",
			updatedAt: NOW - DAY,
			venueName: "Teatro José Lúcio da Silva",
			venueCity: "Leiria",
			categories: ["Música"],
		});
	});

	/** A slug that no longer exists must be a 404, not an empty page. */
	test("is null for an unknown slug", async () => {
		expect(await eventBySlug(db, "nao-existe")).toBeNull();
	});

	test("returns the stored row, not the merged view", async () => {
		const second = await eventBySlug(db, "peca-21h");
		expect(second?.startAt).toBe(NOW + 5 * DAY + 3 * 3600);
	});

	test("an event without a venue still resolves", async () => {
		expect(await eventBySlug(db, "sem-sitio")).toMatchObject({
			venueName: null,
			categories: ["Música", "Teatro"],
		});
	});
});

describe("eventDirectory", () => {
	test("returns every event, undated and past included, newest first", async () => {
		const rows = await eventDirectory(db);

		expect(rows).toHaveLength(8);
		expect(rows[0]?.slug).toBe("sem-sitio");
		expect(rows.at(-1)?.slug).toBe("passado");
		expect(rows.every((r) => typeof r.description === "string")).toBe(true);
	});

	test("keeps same-day sessions as separate rows", async () => {
		const sessions = (await eventDirectory(db)).filter(
			(r) => r.title === "Peça",
		);
		expect(sessions).toHaveLength(2);
	});
});

describe("eventsBySlugs", () => {
	test("returns [] for an empty slug list", async () => {
		expect(await eventsBySlugs(db, [])).toEqual([]);
	});

	test("resolves saved slugs oldest first without descriptions", async () => {
		const rows = await eventsBySlugs(db, ["cinema", "jazz"]);
		expect(slugs(rows)).toEqual(["jazz", "cinema"]);
		expect("description" in (rows[0] as object)).toBe(false);
	});

	/**
	 * Unlike the agenda, same-day sessions keep their own identity here — the
	 * saved page must count two saved sessions as two rows, not glue them.
	 */
	test("does not merge same-day sessions", async () => {
		const rows = await eventsBySlugs(db, ["peca-18h", "peca-21h"]);
		expect(slugs(rows)).toEqual(["peca-18h", "peca-21h"]);
	});

	test("lets slugs that no longer resolve drop out", async () => {
		const rows = await eventsBySlugs(db, ["jazz", "nao-existe"]);
		expect(slugs(rows)).toEqual(["jazz"]);
	});
});
