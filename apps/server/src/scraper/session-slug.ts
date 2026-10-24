import { lisbonDateTime, lisbonDay } from "./fingerprint";
import type { RawEvent } from "./types";

/**
 * Give same-day sessions of ONE source item distinct `raw.slug`s.
 *
 * Ingest reuses a row when source + `raw.slug` (stored as
 * `event_sources.source_event_id`) + Lisbon day match, so two sessions of an
 * item on one day (18h30 + 21h30) would collapse into a single event. The raw
 * slug is never the public event slug (that is `<title>-<fingerprint>`), so
 * changing it cannot break saved events or `/evento/<slug>` URLs — but it IS
 * the key existing rows are matched on, so identity is kept stable:
 *
 * - the EARLIEST session of each (slug, Lisbon day) keeps the slug unchanged;
 * - each later session gets `<slug>-HHmm` (its Lisbon wall-clock time), which
 *   mirrors the time-of-day already hashed into the fingerprint;
 * - sessions at the identical instant are the same session (same slug);
 * - undated raws and single-session days are untouched.
 *
 * Input order is preserved.
 */
export function disambiguateSameDaySessions(raws: RawEvent[]): RawEvent[] {
	const earliestByGroup = new Map<string, number>();
	for (const raw of raws) {
		if (raw.startAt == null || !raw.slug) continue;
		const key = `${raw.slug}|${lisbonDay(raw.startAt)}`;
		const cur = earliestByGroup.get(key);
		if (cur === undefined || raw.startAt < cur) {
			earliestByGroup.set(key, raw.startAt);
		}
	}
	return raws.map((raw) => {
		if (raw.startAt == null || !raw.slug) return raw;
		const earliest = earliestByGroup.get(
			`${raw.slug}|${lisbonDay(raw.startAt)}`,
		);
		if (earliest === undefined || raw.startAt === earliest) return raw;
		const hhmm = lisbonDateTime(raw.startAt).slice(11).replace(":", "");
		return { ...raw, slug: `${raw.slug}-${hhmm}` };
	});
}
