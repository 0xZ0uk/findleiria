import { createHash } from "node:crypto";

import { DateTime } from "luxon";

import { normalizeTitle, normalizeVenueName, slugify } from "./normalize";
import { cityKey } from "./venue-city";

export const LISBON_ZONE = "Europe/Lisbon";

/**
 * Build an epoch (UTC seconds) for a date/time in the Europe/Lisbon timezone.
 * When `hour`/`minute` are omitted the event is pinned to 00:00 local time.
 */
export function toEpochInLisbon(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
): number {
	const dt = DateTime.fromObject(
		{ year, month, day, hour, minute },
		{ zone: LISBON_ZONE },
	);
	if (!dt.isValid) {
		throw new Error(
			`Invalid Europe/Lisbon datetime: ${year}-${month}-${day} ${hour}:${minute}`,
		);
	}
	return Math.round(dt.toSeconds());
}

/**
 * `toEpochInLisbon` that returns null for a calendar date that cannot exist
 * ("31 de fevereiro", "30/02/2026"). Sources are allowed to be wrong; parsers
 * use this so one bad item is skipped instead of throwing out of the run.
 */
export function toEpochInLisbonOrNull(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
): number | null {
	try {
		return toEpochInLisbon(year, month, day, hour, minute);
	} catch {
		return null;
	}
}

/** `YYYY-MM-DD` of an epoch instant expressed in Europe/Lisbon. */
export function lisbonDay(epochSeconds: number): string {
	return DateTime.fromSeconds(epochSeconds, { zone: LISBON_ZONE }).toFormat(
		"yyyy-LL-dd",
	);
}

/** `YYYY-MM-DD HH:mm` of an epoch instant expressed in Europe/Lisbon. */
export function lisbonDateTime(epochSeconds: number): string {
	return DateTime.fromSeconds(epochSeconds, { zone: LISBON_ZONE }).toFormat(
		"yyyy-LL-dd HH:mm",
	);
}

/**
 * The venue part of a fingerprint: the normalized venue name, plus the venue's
 * TOWN (concelho-level `cityKey`) when known. "Biblioteca Municipal" in
 * Batalha and in Pombal are different places, so the same title at the same
 * time in both must hash apart (C3). An unknown town keeps the pre-C3 form
 * exactly (name only), so null-city sources (BOL) keep their fingerprints.
 * `|` never survives normalizeTitle/slugify, so the two forms cannot collide.
 */
function venuePart(venueRef: string, city: string | null | undefined): string {
	const venue = slugify(normalizeVenueName(venueRef));
	const key = cityKey(city);
	return key === "" ? venue : `${venue}|${key}`;
}

/**
 * Sha1 fingerprint that dedupes an event across scrapes.
 * The venue portion is normalized/slugified so prefixed and canonical venue
 * names produce the same fingerprint, and carries the venue's town (see
 * venuePart). The time-of-day (Europe/Lisbon HH:mm) is
 * included so two sessions of the same show on the same day (e.g. a 18h30 and
 * a 21h30 run) get DISTINCT fingerprints instead of colliding and deduping
 * into one. Events without a time are pinned to 00:00 local by toEpochInLisbon,
 * so they remain deterministic.
 *
 * `city` omitted/null/unknown ⇒ the pre-C3 town-less fingerprint, which is
 * also how ingest recognises rows hashed before the town was part of it.
 */
export function fingerprint(
	title: string,
	venueRef: string,
	startAtEpoch: number,
	city: string | null = null,
): string {
	const dt = lisbonDateTime(startAtEpoch);
	return createHash("sha1")
		.update(`${normalizeTitle(title)}|${venuePart(venueRef, city)}|${dt}`)
		.digest("hex");
}

/**
 * Fingerprint for events WITHOUT a machine-readable date. Uses the literal
 * `UNDATED` marker instead of a timestamp so re-scraping the same item never
 * mints a new fingerprint (an ingestion-time date would rotate daily).
 * Promotion to dated (same normalized title + venue gains a date) naturally
 * yields a different fingerprint — ingest links the two via event_sources.
 */
export function fingerprintUndated(
	title: string,
	venueRef: string,
	city: string | null = null,
): string {
	return createHash("sha1")
		.update(`${normalizeTitle(title)}|${venuePart(venueRef, city)}|UNDATED`)
		.digest("hex");
}
