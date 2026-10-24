import { db, schema } from "@events-tracker/db";
import { and, isNotNull, isNull, lt, or } from "drizzle-orm";

import { deleteEvents } from "./event-delete";
import { isExpired } from "./lifecycle";

/**
 * Delete every expired dated event. Run after each scrape cycle so the DB
 * only ever holds events that are today or in the future (user-visible
 * queries already filter, but the rows shouldn't exist at all — they
 * otherwise accumulate from archive-y sources like CM Leiria's RSS).
 *
 * event_sources rows go with them; venues are kept (registry, not lifecycle).
 */
export async function purgePastEvents(now = Math.floor(Date.now() / 1000)) {
	// SQL only narrows to candidates (anything that could be expired has a
	// start or end before now); the real rule lives in isExpired because an
	// open-ended row lasts to the end of its Lisbon day, which SQL can't say.
	const candidates = await db
		.select({
			id: schema.events.id,
			start_at: schema.events.start_at,
			end_at: schema.events.end_at,
			date_text: schema.events.date_text,
		})
		.from(schema.events)
		.where(
			and(
				isNull(schema.events.date_text),
				or(
					and(isNotNull(schema.events.end_at), lt(schema.events.end_at, now)),
					and(isNull(schema.events.end_at), lt(schema.events.start_at, now)),
				),
			),
		);
	const expired = candidates.filter((e) => isExpired(e, now));
	return deleteEvents(expired.map((e) => e.id));
}

// Standalone execution: bun run src/scraper/purge.ts
if (import.meta.main) {
	const n = await purgePastEvents();
	console.log(JSON.stringify({ purged: n }));
}
