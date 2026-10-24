import { and, desc, eq, sql } from "drizzle-orm";

import { authDb } from "./db.js";
import { savedEvent } from "./schema.js";

/**
 * A user's saved-event slice: idempotent save/unsave and a newest-first slug
 * list, all on the auth database. The unique (user, slug) index is what makes
 * `saveEvent` a no-op when the row already exists.
 */

/** Most saved events one reader can hold; a bound, not a product feature. */
export const MAX_SAVED_PER_USER = 500;

/** Upper bound on a slug's length (a long title's slug plus `-fp12`). */
export const MAX_SLUG_LENGTH = 200;

/**
 * The shape ingest produces: `slugify(title)-fp12`, i.e. lowercase letters and
 * numbers (any script, diacritics already stripped) in hyphen-separated runs.
 * Shape only: the server cannot see the snapshot, so whether the event exists
 * is the saved page's problem (it renders unresolved slugs as "unavailable").
 */
const SLUG_SHAPE = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;

export function isValidSlug(slug: string): boolean {
	return slug.length <= MAX_SLUG_LENGTH && SLUG_SHAPE.test(slug);
}

/** Newest first — the saved page reads newest-saved on top. */
export async function listSavedSlugs(userId: string): Promise<string[]> {
	const rows = await authDb
		.select({ eventSlug: savedEvent.eventSlug })
		.from(savedEvent)
		.where(eq(savedEvent.userId, userId))
		.orderBy(desc(savedEvent.createdAt));

	return rows.map((row) => row.eventSlug);
}

/**
 * Save one slug, unless the reader is already at `MAX_SAVED_PER_USER`.
 *
 * The cap is enforced inside the INSERT (a conditional insert-select) rather
 * than as count-then-insert, so two concurrent requests cannot both squeeze
 * past it. Re-saving a slug the reader already holds stays a success at the
 * cap: it is an idempotent no-op, not a new row.
 */
export async function saveEvent(
	userId: string,
	slug: string,
): Promise<"saved" | "limit"> {
	// RETURNING, not a driver's affected-row count (libSQL `rowsAffected`, D1
	// `meta.changes`): a skipped insert (cap reached, or already saved) returns
	// no row on either.
	const inserted = await authDb.all(sql`
		INSERT INTO saved_event (id, user_id, event_slug, created_at)
		SELECT ${crypto.randomUUID()}, ${userId}, ${slug}, ${Math.floor(Date.now() / 1000)}
		WHERE (SELECT count(*) FROM saved_event WHERE user_id = ${userId}) < ${MAX_SAVED_PER_USER}
		ON CONFLICT DO NOTHING
		RETURNING id`);
	if (inserted.length > 0) return "saved";

	const existing = await authDb
		.select({ id: savedEvent.id })
		.from(savedEvent)
		.where(and(eq(savedEvent.userId, userId), eq(savedEvent.eventSlug, slug)))
		.limit(1);
	return existing.length > 0 ? "saved" : "limit";
}

export async function unsaveEvent(userId: string, slug: string): Promise<void> {
	await authDb
		.delete(savedEvent)
		.where(and(eq(savedEvent.userId, userId), eq(savedEvent.eventSlug, slug)));
}
