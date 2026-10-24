/**
 * C3 against a real libSQL file DB with the shipped migrations applied.
 *
 * Env-independent: `@events-tracker/db` is mocked with a temp-file DB BEFORE
 * the code under test is imported, so neither DATABASE_URL nor CORS_ORIGIN is
 * read here (and whatever DATABASE_URL points at is never touched). Bun
 * patches already-loaded bindings too, so this holds when another test file
 * imported the real module first.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as schema from "@events-tracker/db/schema/index";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import { fingerprint } from "./fingerprint";
import { slugify } from "./normalize";
import type { RawEvent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "c3-venue-towns-"));
const testDb = drizzle({
	connection: { url: `file:${join(dir, "test.db")}` },
	schema,
});
mock.module("@events-tracker/db", () => ({
	db: testDb,
	schema,
	createDb: () => testDb,
}));
const { ingest } = await import("./ingest");
const { planRepair, repairVenueTowns } = await import("./repair-venue-towns");

const MIGRATIONS = join(
	import.meta.dir,
	"../../../../packages/db/src/migrations",
);
/** 2030-03-17 — safely in the future, so the past guard and purge stay out. */
const START = 1_900_000_000;
const DAY = 86_400;

beforeAll(async () => {
	await migrate(testDb, { migrationsFolder: MIGRATIONS });
});

beforeEach(async () => {
	await testDb.delete(schema.eventSources);
	await testDb.delete(schema.events);
	await testDb.delete(schema.venues);
	await testDb.delete(schema.scrapeRuns);
});

afterAll(() => {
	testDb.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

const raw = (over: Partial<RawEvent>): RawEvent => ({
	title: "Concerto de Natal",
	slug: "item",
	description: null,
	startAt: START,
	endAt: null,
	dateText: null,
	venueName: "Biblioteca Municipal",
	city: "Leiria",
	categories: [],
	imageUrl: null,
	url: "https://example.test/item",
	...over,
});

async function eventsWithTown() {
	return testDb
		.select({
			id: schema.events.id,
			slug: schema.events.slug,
			title: schema.events.title,
			fingerprint: schema.events.fingerprint,
			venueId: schema.events.venue_id,
			venueSlug: schema.venues.slug,
			city: schema.venues.city,
		})
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.orderBy(schema.events.id);
}

async function sourcesOf(eventId: number) {
	const rows = await testDb
		.select({
			source: schema.eventSources.source,
			item: schema.eventSources.source_event_id,
		})
		.from(schema.eventSources)
		.where(eq(schema.eventSources.event_id, eventId));
	return rows.map((r) => `${r.source}:${r.item}`).sort();
}

describe("ingest keeps same-named venues in different towns apart", () => {
	test("one generic venue name in two towns → two venues, two events, right towns", async () => {
		const batch = [
			raw({
				slug: "bt-1",
				city: "Batalha",
				url: "https://www.cm-batalha.pt/1",
			}),
			raw({ slug: "pb-1", city: "Pombal", url: "https://pombal.test/1" }),
		];
		const first = await ingest(batch, "municipal");
		expect(first.itemsNew).toBe(2);
		expect(first.error).toBeNull();

		const venues = await testDb
			.select()
			.from(schema.venues)
			.orderBy(schema.venues.id);
		expect(venues.map((v) => [v.slug, v.city])).toEqual([
			["biblioteca-municipal", "Batalha"],
			["biblioteca-municipal-pombal", "Pombal"],
		]);
		const events = await eventsWithTown();
		expect(events.map((e) => e.city).sort()).toEqual(["Batalha", "Pombal"]);
		expect(new Set(events.map((e) => e.fingerprint)).size).toBe(2);

		const second = await ingest(batch, "municipal");
		expect(second.itemsNew).toBe(0);
		expect(second.itemsFailed).toBe(0);
		expect(await eventsWithTown()).toEqual(events);
	});

	test("one town spelled two ways by two sources → one venue, one event", async () => {
		await ingest(
			[raw({ slug: "mg-1", city: "Marinha Grande", venueName: "Cine-Teatro" })],
			"municipal",
		);
		const second = await ingest(
			[
				raw({
					slug: "va-1",
					city: "Ordem",
					venueName: "Cine-Teatro",
					url: "https://va.test/1",
				}),
			],
			"viralagenda",
		);
		expect(second.itemsNew).toBe(0);
		expect(await testDb.select().from(schema.venues)).toHaveLength(1);
		const [event] = await eventsWithTown();
		expect(event?.city).toBe("Marinha Grande");
		expect(await sourcesOf(event?.id ?? 0)).toEqual([
			"municipal:mg-1",
			"viralagenda:va-1",
		]);
	});

	test("unknown town: borrows an unambiguous name, never guesses between towns", async () => {
		await ingest(
			[
				raw({
					slug: "lg-1",
					venueName: "Teatro Miguel Franco",
					city: "Leiria",
				}),
				raw({ slug: "bt-1", city: "Batalha" }),
				raw({ slug: "pb-1", city: "Pombal" }),
			],
			"municipal",
		);
		const res = await ingest(
			[
				raw({
					slug: "bol-1",
					title: "Peça",
					venueName: "Teatro Miguel Franco",
					city: null,
				}),
				raw({ slug: "bol-2", title: "Recital", city: null }),
			],
			"bol",
		);
		expect(res.itemsNew).toBe(2);
		const events = await eventsWithTown();
		expect(events.find((e) => e.title === "Peça")?.city).toBe("Leiria");
		const recital = events.find((e) => e.title === "Recital");
		expect(recital?.city).toBe("Leiria (distrito)");
		expect(recital?.venueSlug).toBe("biblioteca-municipal-distrito");
		// Not folded into either town by the venue merge.
		expect(await testDb.select().from(schema.venues)).toHaveLength(4);
		expect(
			(
				await ingest(
					[raw({ slug: "bol-2", title: "Recital", city: null })],
					"bol",
				)
			).itemsNew,
		).toBe(0);
	});
});

/**
 * A pre-C3 DB: "Biblioteca Municipal" is ONE row (Leiria, the first town to
 * use the name) and every fingerprint is town-less.
 *  - "Hora do Conto": a Leiria event, minted by leiriagenda.
 *  - "Clube de Leitura": a BATALHA event (minted by Batalha's municipal site)
 *    that the old resolver filed under Leiria's row.
 *  - "Concerto de Natal": two events, one per town, that collided on the
 *    town-less fingerprint; Leiria's minted the row, Batalha's attribution was
 *    glued on as "unchanged".
 */
async function seedLegacy() {
	const [leiria] = await testDb
		.insert(schema.venues)
		.values({
			name: "Biblioteca Municipal",
			slug: "biblioteca-municipal",
			city: "Leiria",
		})
		.returning();
	if (!leiria) throw new Error("seed");
	const mint = async (
		title: string,
		start: number,
		attributions: { source: string; item: string; url: string; seen: number }[],
	) => {
		const fp = fingerprint(title, "biblioteca-municipal", start);
		const [ev] = await testDb
			.insert(schema.events)
			.values({
				title,
				slug: `${slugify(title)}-${fp.slice(0, 12)}`,
				start_at: start,
				venue_id: leiria.id,
				url: attributions[0]?.url,
				categories: [],
				fingerprint: fp,
				created_at: 1,
				updated_at: 1,
			})
			.returning();
		if (!ev) throw new Error("seed");
		for (const a of attributions) {
			await testDb.insert(schema.eventSources).values({
				event_id: ev.id,
				source: a.source,
				source_event_id: a.item,
				source_url: a.url,
				first_seen_at: a.seen,
			});
		}
		return ev;
	};
	const conto = await mint("Hora do Conto", START, [
		{
			source: "leiriagenda",
			item: "lg-1",
			url: "https://leiriagenda.test/1",
			seen: 10,
		},
	]);
	const clube = await mint("Clube de Leitura", START + DAY, [
		{
			source: "municipal",
			item: "bt-2",
			url: "https://www.cm-batalha.pt/2",
			seen: 10,
		},
	]);
	const concerto = await mint("Concerto de Natal", START + 2 * DAY, [
		{
			source: "leiriagenda",
			item: "lg-3",
			url: "https://leiriagenda.test/3",
			seen: 10,
		},
		{
			source: "municipal",
			item: "bt-3",
			url: "https://www.cm-batalha.pt/3",
			seen: 20,
		},
	]);
	const leiriaBatch = [
		raw({
			slug: "lg-1",
			title: "Hora do Conto",
			url: "https://leiriagenda.test/1",
		}),
		raw({
			slug: "lg-3",
			startAt: START + 2 * DAY,
			url: "https://leiriagenda.test/3",
		}),
	];
	const batalhaBatch = [
		raw({
			slug: "bt-2",
			title: "Clube de Leitura",
			startAt: START + DAY,
			city: "Batalha",
			url: "https://www.cm-batalha.pt/2",
		}),
		raw({
			slug: "bt-3",
			startAt: START + 2 * DAY,
			city: "Batalha",
			url: "https://www.cm-batalha.pt/3",
		}),
	];
	return { leiria, conto, clube, concerto, leiriaBatch, batalhaBatch };
}

async function expectConverged(seed: Awaited<ReturnType<typeof seedLegacy>>) {
	const events = await eventsWithTown();
	expect(events).toHaveLength(4);
	const byId = new Map(events.map((e) => [e.id, e]));
	// Existing slugs are untouched and still name the same event.
	expect(byId.get(seed.conto.id)?.slug).toBe(seed.conto.slug);
	expect(byId.get(seed.clube.id)?.slug).toBe(seed.clube.slug);
	expect(byId.get(seed.concerto.id)?.slug).toBe(seed.concerto.slug);
	// Leiria's events stay in Leiria; the misfiled Batalha one moved home.
	expect(byId.get(seed.conto.id)?.city).toBe("Leiria");
	expect(byId.get(seed.concerto.id)?.city).toBe("Leiria");
	expect(byId.get(seed.clube.id)?.city).toBe("Batalha");
	expect(byId.get(seed.clube.id)?.venueSlug).toBe(
		"biblioteca-municipal-batalha",
	);
	// Everyone is on the town-qualified fingerprint.
	expect(byId.get(seed.conto.id)?.fingerprint).toBe(
		fingerprint("Hora do Conto", "Biblioteca Municipal", START, "Leiria"),
	);
	expect(byId.get(seed.clube.id)?.fingerprint).toBe(
		fingerprint(
			"Clube de Leitura",
			"Biblioteca Municipal",
			START + DAY,
			"Batalha",
		),
	);
	// The collided Batalha concert is its own row now, and the Leiria row no
	// longer carries its attribution.
	const batalhaConcerto = events.find(
		(e) => e.title === "Concerto de Natal" && e.city === "Batalha",
	);
	expect(batalhaConcerto).toBeDefined();
	expect(await sourcesOf(seed.concerto.id)).toEqual(["leiriagenda:lg-3"]);
	expect(await sourcesOf(batalhaConcerto?.id ?? 0)).toEqual(["municipal:bt-3"]);
	expect(await testDb.select().from(schema.venues)).toHaveLength(2);
}

describe("a pre-C3 DB converges on the next normal scrape (no repair run)", () => {
	test("rows are re-homed and re-hashed in place; a second scrape adds nothing", async () => {
		const seed = await seedLegacy();
		// Batalha first: the harder order (it meets the collided row first).
		const bt = await ingest(seed.batalhaBatch, "municipal");
		const lg = await ingest(seed.leiriaBatch, "leiriagenda");
		expect(bt.itemsNew).toBe(1); // only the concert that was swallowed
		expect(lg.itemsNew).toBe(0);
		await expectConverged(seed);

		expect((await ingest(seed.batalhaBatch, "municipal")).itemsNew).toBe(0);
		expect((await ingest(seed.leiriaBatch, "leiriagenda")).itemsNew).toBe(0);
		await expectConverged(seed);
	});
});

describe("repair-venue-towns on a seeded pre-C3 DB", () => {
	test("dry run writes nothing; apply re-homes + re-hashes; idempotent; scrape adds no duplicates", async () => {
		const seed = await seedLegacy();
		const before = await eventsWithTown();

		const dry = await repairVenueTowns(false);
		expect(await eventsWithTown()).toEqual(before);
		expect(await testDb.select().from(schema.venues)).toHaveLength(1);
		expect(dry.ops.filter((o) => o.kind === "createVenue")).toEqual([
			expect.objectContaining({
				slug: "biblioteca-municipal-batalha",
				city: "Batalha",
			}),
		]);
		expect(dry.ops.filter((o) => o.kind === "moveEvent")).toEqual([
			expect.objectContaining({ eventId: seed.clube.id }),
		]);
		expect(dry.ops.filter((o) => o.kind === "rehash")).toHaveLength(3);
		expect(dry.collisions).toEqual([
			{
				eventId: seed.concerto.id,
				slug: seed.concerto.slug,
				towns: ["Batalha"],
			},
		]);

		await repairVenueTowns(true);
		const after = await eventsWithTown();
		expect(after.map((e) => e.slug)).toEqual(before.map((e) => e.slug));
		expect(after.find((e) => e.id === seed.clube.id)?.city).toBe("Batalha");
		expect(after.find((e) => e.id === seed.concerto.id)?.city).toBe("Leiria");

		const again = await planRepair();
		expect(again.ops).toEqual([]);
		expect(again.alreadyCurrent).toBe(3);

		// The next scrape finds every repaired row; only the swallowed concert is new.
		expect((await ingest(seed.batalhaBatch, "municipal")).itemsNew).toBe(1);
		expect((await ingest(seed.leiriaBatch, "leiriagenda")).itemsNew).toBe(0);
		await expectConverged(seed);
		expect((await planRepair()).ops).toEqual([]);
	});
});
