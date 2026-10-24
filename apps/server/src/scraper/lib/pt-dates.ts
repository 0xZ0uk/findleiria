/**
 * Portuguese date primitives shared by the source scrapers.
 *
 * One month table (full names + 3-letter abbreviations, accent-folded keys)
 * replaces the eight private copies the sources used to carry, plus the
 * `YYYY-MM-DD[ HH:mm]` -> epoch mechanics several of them repeated. Epochs are
 * always built through `toEpochInLisbonOrNull`, so a calendar date that cannot
 * exist ("31 de fevereiro") is `null` here rather than a throw.
 *
 * Site-specific DIALECTS (card layouts, range grammars, year inference) stay
 * in each source; they are built on top of these primitives.
 */
import { toEpochInLisbonOrNull } from "../fingerprint";

/** Lowercase and strip diacritics ("Março" -> "marco"). */
export function foldAccents(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

/**
 * Month number by accent-folded name or 3-letter abbreviation. Keys are
 * folded, so look up through `monthFromName` / `monthFromPrefix` rather than
 * indexing with raw text.
 */
export const PT_MONTHS: Readonly<Record<string, number>> = {
	janeiro: 1,
	fevereiro: 2,
	marco: 3,
	abril: 4,
	maio: 5,
	junho: 6,
	julho: 7,
	agosto: 8,
	setembro: 9,
	outubro: 10,
	novembro: 11,
	dezembro: 12,
	jan: 1,
	fev: 2,
	mar: 3,
	abr: 4,
	mai: 5,
	jun: 6,
	jul: 7,
	ago: 8,
	set: 9,
	out: 10,
	nov: 11,
	dez: 12,
};

/**
 * Regex alternation of every month name/abbreviation, longest first so
 * "setembro" wins over "set". Includes the accented "março" so it can be
 * matched against raw (unfolded) text.
 */
export const MONTH_NAME_ALT: string = [...Object.keys(PT_MONTHS), "março"]
	.sort((a, b) => b.length - a.length)
	.join("|");

/**
 * Month (1-12) for a full name or abbreviation, any case/accents, tolerating a
 * trailing dot or whitespace ("Set.", "março"). Null when it is not a month.
 */
export function monthFromName(token: string): number | null {
	const key = foldAccents(token)
		.replace(/[.\s]+$/, "")
		.trim();
	return PT_MONTHS[key] ?? null;
}

/**
 * Month from the first three letters of a token ("setembro", "Sept.", "set").
 * For sources that only ever see a month word and tolerate sloppy spellings.
 */
export function monthFromPrefix(token: string): number | null {
	return PT_MONTHS[foldAccents(token).trim().slice(0, 3)] ?? null;
}

/**
 * Epoch (UTC seconds) for a `YYYY-MM-DD` prefix plus an optional `H:mm` /
 * `HH:mm` time, read as Europe/Lisbon wall clock. Without a time the instant
 * is 00:00 local. Null when the date is malformed or impossible.
 */
export function ymdToEpoch(
	date: string | null | undefined,
	time?: string | null,
): number | null {
	if (!date) {
		return null;
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
	if (!m) {
		return null;
	}
	const tm = time ? /^(\d{1,2}):(\d{2})/.exec(time) : null;
	return toEpochInLisbonOrNull(
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		tm ? Number(tm[1]) : 0,
		tm ? Number(tm[2]) : 0,
	);
}
