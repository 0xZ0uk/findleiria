import { db, schema } from "@events-tracker/db";
import { inArray } from "drizzle-orm";

import type { Conn } from "./conn";

/**
 * Delete events together with their `event_sources` rows.
 *
 * `event_sources.event_id` declares ON DELETE CASCADE, but the local SQLite
 * connection runs with foreign keys off (the libsql client never turns
 * `PRAGMA foreign_keys` on), so the cascade never fires: every event delete
 * stranded its attribution rows — 31 orphans by the time the Turso publish
 * failed its FK check. Deleting dependents explicitly gives the intended
 * result without depending on a pragma.
 */
export async function deleteEvents(
	ids: number[],
	conn: Conn = db,
): Promise<number> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return 0;
	await conn
		.delete(schema.eventSources)
		.where(inArray(schema.eventSources.event_id, unique));
	const deleted = await conn
		.delete(schema.events)
		.where(inArray(schema.events.id, unique))
		.returning({ id: schema.events.id });
	return deleted.length;
}
