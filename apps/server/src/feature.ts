import { db, schema } from "@events-tracker/db";
import { asc, eq, isNotNull } from "drizzle-orm";

import type { Conn } from "./scraper/conn";
import { lisbonDay } from "./scraper/fingerprint";

/**
 * Week's-pick CLI — the only writer of `events.featured_at`. Ingest and the
 * scrapers never touch the column, so a pick survives re-scrapes.
 *
 * Usage:
 *   bun run src/feature.ts <slug>            # pick the event (featured_at = now)
 *   bun run src/feature.ts --clear <slug>    # drop the pick
 *   bun run src/feature.ts --list            # current picks, soonest first
 *
 * Writes the database the other server CLIs use (DATABASE_URL, i.e. local.db).
 * A pick reaches the site with the next `db:publish`, which mirrors every
 * column to Turso, and the Vercel rebuild that follows it.
 */

export interface Pick {
	slug: string;
	title: string;
	startAt: number;
	featuredAt: number | null;
}

async function findBySlug(conn: Conn, slug: string): Promise<Pick | null> {
	const rows = await conn
		.select({
			slug: schema.events.slug,
			title: schema.events.title,
			startAt: schema.events.start_at,
			featuredAt: schema.events.featured_at,
		})
		.from(schema.events)
		.where(eq(schema.events.slug, slug))
		.limit(1);
	return rows[0] ?? null;
}

/** Mark the event as a pick. Null when the slug is unknown. */
export async function setFeatured(
	slug: string,
	now: number = Math.floor(Date.now() / 1000),
	conn: Conn = db,
): Promise<Pick | null> {
	const found = await findBySlug(conn, slug);
	if (!found) return null;
	await conn
		.update(schema.events)
		.set({ featured_at: now })
		.where(eq(schema.events.slug, slug));
	return { ...found, featuredAt: now };
}

/** Drop the pick. Null when the slug is unknown; a no-op when it was not picked. */
export async function clearFeatured(
	slug: string,
	conn: Conn = db,
): Promise<Pick | null> {
	const found = await findBySlug(conn, slug);
	if (!found) return null;
	if (found.featuredAt != null) {
		await conn
			.update(schema.events)
			.set({ featured_at: null })
			.where(eq(schema.events.slug, slug));
	}
	return { ...found, featuredAt: null };
}

/** Every current pick, soonest event first. */
export async function listFeatured(conn: Conn = db): Promise<Pick[]> {
	return conn
		.select({
			slug: schema.events.slug,
			title: schema.events.title,
			startAt: schema.events.start_at,
			featuredAt: schema.events.featured_at,
		})
		.from(schema.events)
		.where(isNotNull(schema.events.featured_at))
		.orderBy(asc(schema.events.start_at), asc(schema.events.id));
}

const fmt = (p: Pick) => `${p.slug}\t${lisbonDay(p.startAt)}\t${p.title}`;

const USAGE = `usage:
  bun run src/feature.ts <slug>            pick an event
  bun run src/feature.ts --clear <slug>    drop a pick
  bun run src/feature.ts --list            list current picks`;

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv.length === 1 && argv[0] === "--list") {
		const picks = await listFeatured();
		console.log(
			picks.length === 0
				? "Sem eventos em destaque."
				: picks.map(fmt).join("\n"),
		);
	} else if (argv.length === 2 && argv[0] === "--clear" && argv[1]) {
		const cleared = await clearFeatured(argv[1]);
		if (!cleared) {
			console.error(`no event with slug "${argv[1]}"`);
			process.exit(1);
		}
		console.log(`cleared: ${fmt(cleared)}`);
	} else if (argv.length === 1 && argv[0] && !argv[0].startsWith("--")) {
		const picked = await setFeatured(argv[0]);
		if (!picked) {
			console.error(`no event with slug "${argv[0]}"`);
			process.exit(1);
		}
		console.log(`featured: ${fmt(picked)}`);
	} else {
		console.error(USAGE);
		process.exit(1);
	}
}
