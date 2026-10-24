import fs from "node:fs";
import path from "node:path";

import { createReadDb, type Db } from "@events-tracker/db/client";

import {
	eventDirectory,
	eventStats,
	listEvents,
	listInput,
	undatedEvents,
	WINDOW_MAX,
} from "./queries/events";
import {
	AGENDA_FILE,
	AGENDA_WINDOW_DAYS,
	type AgendaSnapshot,
	type EventDetail,
	SNAPSHOT_LOOKBACK_DAYS,
	SNAPSHOT_SLACK_DAYS,
	SNAPSHOT_VERSION,
} from "./snapshot-shape";

/**
 * The build-time half of the static snapshot (see `./snapshot-shape.ts`).
 *
 * The same query functions the dev tRPC router wraps, run once against
 * Turso (production build) or `local.db` (dev), and written out as JSON.
 * Node-only: the web bundle never imports this file, only the shape module.
 */

const DAY = 86_400;

export type Snapshot = {
	agenda: AgendaSnapshot;
	/** Every event with its description, newest first: per-event files and pages. */
	events: EventDetail[];
};

export { EMBEDDED_EVENT_ID } from "./snapshot-shape";
export { createReadDb };

/** Read everything the site serves, in four queries. */
export async function buildSnapshot(
	db: Db,
	nowMs: number = Date.now(),
): Promise<Snapshot> {
	const now = Math.floor(nowMs / 1000);
	const covers = {
		from: now - SNAPSHOT_LOOKBACK_DAYS * DAY,
		to: now + (AGENDA_WINDOW_DAYS + SNAPSHOT_SLACK_DAYS) * DAY,
	};

	const [events, undated, stats, directory] = await Promise.all([
		listEvents(
			db,
			listInput.parse({
				dateFrom: covers.from,
				dateTo: covers.to,
				includeUndated: false,
				limit: WINDOW_MAX,
			}),
		),
		undatedEvents(db),
		eventStats(db),
		eventDirectory(db),
	]);

	return {
		agenda: {
			version: SNAPSHOT_VERSION,
			generatedAt: now,
			covers,
			truncated: events.length >= WINDOW_MAX,
			stats,
			events,
			undated,
		},
		events: directory,
	};
}

/**
 * A slug becomes a file name, so refuse anything that could leave the
 * directory or collide. The scraper only emits url-safe slugs; this is the
 * tripwire if that ever changes.
 */
export function assertFileSafeSlug(slug: string): void {
	if (
		!slug ||
		slug === "." ||
		slug === ".." ||
		/[/\\\0]/.test(slug) ||
		slug !== slug.trim()
	) {
		throw new Error(
			`Refusing to write a snapshot file for slug ${JSON.stringify(slug)}.`,
		);
	}
}

export type WrittenSnapshot = { files: number; bytes: number };

/**
 * Write the snapshot under `dir` (`dist/data` or `public/data`), replacing
 * whatever an earlier run left there so a deleted event cannot linger.
 */
export function writeSnapshot(
	dir: string,
	snapshot: Snapshot,
): WrittenSnapshot {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, "events"), { recursive: true });

	let files = 0;
	let bytes = 0;
	const write = (file: string, value: unknown) => {
		const body = JSON.stringify(value);
		fs.writeFileSync(file, body);
		files += 1;
		bytes += Buffer.byteLength(body);
	};

	write(path.join(dir, AGENDA_FILE), snapshot.agenda);
	for (const event of snapshot.events) {
		assertFileSafeSlug(event.slug);
		write(path.join(dir, "events", `${event.slug}.json`), event);
	}
	return { files, bytes };
}
