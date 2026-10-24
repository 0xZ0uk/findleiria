/**
 * Event lifecycle rules — pure, no DB.
 */
import { DateTime } from "luxon";

import { LISBON_ZONE } from "./fingerprint";

export interface LifecycleEvent {
	start_at: number;
	end_at: number | null;
	/** Non-null ⇒ undated row: start_at is an ingestion placeholder. */
	date_text: string | null;
}

/**
 * Last instant (epoch seconds) an event still counts as happening, or the
 * value to compare against `now` for expiry. A real `end_at` wins. Without
 * one (or with an end that doesn't follow the start) the row is OPEN-ENDED
 * and lasts to the END of its Europe/Lisbon calendar day: date-only events
 * are pinned to 00:00 Lisbon, so comparing start_at itself would expire a
 * festa at the first run after midnight on the day it happens. Calendar
 * (not +24h) so DST days of 23/25 hours still end at 23:59:59 local.
 */
export function lastInstant(startAt: number, endAt: number | null): number {
	if (endAt != null && endAt > startAt) return endAt;
	return Math.floor(
		DateTime.fromSeconds(startAt, { zone: LISBON_ZONE })
			.endOf("day")
			.toSeconds(),
	);
}

/**
 * A dated event is expired once its last known instant has passed (see
 * `lastInstant`). Undated rows are never expired — their start_at carries no
 * real meaning.
 */
export function isExpired(event: LifecycleEvent, now: number): boolean {
	if (event.date_text != null) return false;
	return lastInstant(event.start_at, event.end_at) < now;
}
