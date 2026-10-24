import { isLeiriaDistrict } from "./district";
import { toEpochInLisbonOrNull } from "./fingerprint";
import { defaultFetchText } from "./http";
import type { RawEvent } from "./types";

/**
 * Eventbrite source (SLICE_4).
 *
 * The public Leiria listing (eventbrite.pt/d/portugal--leiria/events/) embeds
 * the full structured event payload in `window.__SERVER_DATA__` — no browser
 * rendering needed. Pagination via ?page=N (16 events per page, verified to
 * at least page 15 live).
 *
 * Concelho scope: only events whose venue address city is Leiria are
 * ingested (adjacent-district events — Alcobaça, Tomar etc. — are dropped).
 */

export const LISTING_URL =
	"https://www.eventbrite.pt/d/portugal--leiria/events/";

export const MAX_PAGES = 20;

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
}

interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, ms));
const randomDelay = () => 400 + Math.floor(Math.random() * 200);

/** Extract the `window.__SERVER_DATA__` JSON object from an Eventbrite page. */
export function extractServerData(html: string): unknown | null {
	const marker = html.indexOf("window.__SERVER_DATA__");
	if (marker < 0) {
		return null;
	}
	const start = html.indexOf("{", marker);
	if (start < 0) {
		return null;
	}
	// Brace-balance to the matching close (string literals skipped).
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < html.length; i++) {
		const ch = html[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) {
				escaped = true;
			}
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(html.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

interface EbEvent {
	name?: { text?: string } | string;
	eid?: string;
	id?: string;
	start_date?: string;
	start_time?: string;
	end_date?: string;
	end_time?: string;
	summary?: string;
	url?: string;
	is_cancelled?: boolean;
	is_online_event?: boolean;
	primary_venue?: {
		name?: string;
		address?: { city?: string };
	} | null;
	image?: { url?: string } | null;
}

/** Pull every event object out of the parsed SERVER_DATA (all buckets). */
export function collectEvents(data: unknown): EbEvent[] {
	const out: EbEvent[] = [];
	const buckets = (data as { buckets?: unknown })?.buckets;
	if (!Array.isArray(buckets)) {
		return out;
	}
	for (const b of buckets) {
		const events = (b as { events?: unknown })?.events;
		if (Array.isArray(events)) {
			out.push(...(events as EbEvent[]));
		}
	}
	return out;
}

function parseIsoDate(
	date: string | undefined,
	time: string | undefined,
): number | null {
	if (!date) {
		return null;
	}
	const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (!m) {
		return null;
	}
	const tm = time?.match(/^(\d{1,2}):(\d{2})/) ?? null;
	return toEpochInLisbonOrNull(
		Number.parseInt(m[1] ?? "0", 10),
		Number.parseInt(m[2] ?? "0", 10),
		Number.parseInt(m[3] ?? "0", 10),
		tm ? Number.parseInt(tm[1] ?? "0", 10) : 0,
		tm ? Number.parseInt(tm[2] ?? "0", 10) : 0,
	);
}

function eventName(e: EbEvent): string {
	const n = e.name;
	if (typeof n === "string") {
		return n;
	}
	return n?.text ?? "";
}

/** True when a date field is present but names a day that cannot exist. */
function hasImpossibleDate(e: EbEvent): boolean {
	return (
		(!!e.start_date && parseIsoDate(e.start_date, e.start_time) == null) ||
		(!!e.end_date && parseIsoDate(e.end_date, e.end_time) == null)
	);
}

/** Map one Eventbrite payload event to a RawEvent (null when unusable). */
export function toRawEvent(e: EbEvent): RawEvent | null {
	const eid = e.eid ?? e.id;
	const title = eventName(e).trim();
	if (!eid || !title) {
		return null;
	}
	if (e.is_cancelled || e.is_online_event) {
		return null;
	}
	const startAt = parseIsoDate(e.start_date, e.start_time);
	if (startAt == null) {
		return null;
	}
	const endAt = parseIsoDate(e.end_date, e.end_time);
	if (e.end_date && endAt == null) {
		return null; // end names a day that cannot exist → skip the item
	}
	const venueName = e.primary_venue?.name?.trim() || "Local a definir";
	const city = e.primary_venue?.address?.city?.trim() || null;
	return {
		title,
		slug: `eb-${eid}`,
		description: e.summary?.trim() || null,
		startAt,
		endAt,
		dateText: null,
		venueName,
		city,
		// No platform-name category; canonicalization happens at ingest.
		categories: [],
		imageUrl: e.image?.url ?? null,
		url:
			e.url ??
			`https://www.eventbrite.pt/e/${title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")}-tickets-${eid}`,
	};
}

/**
 * Scrape Eventbrite's Leiria listing: fetch pages until one comes back empty
 * (or the cap), collect events, keep only venue-city 'Leiria' (concelho
 * scope). Per-page failures are counted, never fatal.
 */
export async function scrape(
	deps: ScrapeDeps = { fetchText: defaultFetchText, sleep: defaultSleep },
): Promise<ScrapeResult> {
	const byEid = new Map<string, RawEvent>();
	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;

	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = page === 1 ? LISTING_URL : `${LISTING_URL}?page=${page}`;
		try {
			await deps.sleep(randomDelay());
			const html = await deps.fetchText(url);
			pagesFetched++;
			const data = extractServerData(html);
			const events = data ? collectEvents(data) : [];
			if (events.length === 0) {
				break;
			}
			for (const e of events) {
				const raw = toRawEvent(e);
				if (!raw) {
					// An impossible date skips this item only — the remaining
					// events and pages still parse.
					if (hasImpossibleDate(e)) {
						failures++;
						firstError ??= `${e.eid ?? e.id}: impossible date`;
					}
					continue;
				}
				// District scope: venue city must be one of the 14 district
				// municipalities (district.ts is the authority).
				if (!isLeiriaDistrict(raw.city)) {
					continue;
				}
				if (!byEid.has(raw.slug)) {
					byEid.set(raw.slug, raw);
				}
			}
		} catch (err) {
			failures++;
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
			break;
		}
	}

	return {
		events: [...byEid.values()],
		failures,
		firstError,
		pagesFetched,
	};
}
