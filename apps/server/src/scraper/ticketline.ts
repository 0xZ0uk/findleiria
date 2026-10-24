import * as cheerio from "cheerio";
import { DateTime } from "luxon";
import { isLeiriaDistrict } from "./district";
import { defaultFetchText } from "./http";
import { createFetchGate } from "./lib/fetch-gate";
import { ymdToEpoch } from "./lib/pt-dates";
import { defaultSleep, randomDelay } from "./lib/timing";
import { freeFromPrices } from "./normalize";
import type { RawEvent } from "./types";

/**
 * Ticketline source (SLICE_5 — nightlife discovery).
 *
 * The search endpoint /pesquisa is fully server-rendered: rows are
 * `<li itemscope itemtype="http://schema.org/Event">` cards with a
 * `meta itemprop="startDate" content="YYYY-MM-DD"`, name, venue string and
 * category. We fetch two variants and dedupe by event id:
 *   - full-text search:  /pesquisa?query=leiria
 *   - venue-scoped:      /pesquisa?venues=2101  (a Leiria-city venue; the
 *     venue-scoped channel still catches district-wide tours)
 *
 * Detail pages expose the primary event as schema.org sessions: each
 * `<li itemprop="Event">` carries a resolvable `content="YYYY-MM-DDTHH:mm"`
 * start, a Place with PostalAddress (addressLocality / addressRegion) and a
 * lowPrice. Festival "aggregator" pages (the parent show listing child
 * productions) have no resolvable session — we fall back to the search row.
 *
 * District scope: events are kept when resolved to ANY of the 14 Leiria
 * district municipalities (or Leiria freguesias) — district.ts is the
 * authority. The detail address (locality/region) drives the test; rows
 * listed at past dates are dropped (Ticketline shows past runs too).
 */

export const SITE = "https://www.ticketline.pt";
export const SEARCH_URL = `${SITE}/pesquisa?query=leiria`;
/** A Leiria-city venue (Pigs Arena tour stop) — seeds the district sweep. */
export const VENUE_SEARCH_URL = `${SITE}/pesquisa?venues=2101`;

export const MAX_REQUESTS = 120;
export const MIN_DELAY_MS = 400;
export const MAX_DELAY_MS = 700;
export const DETAIL_CONCURRENCY = 3;
export const LISBON_ZONE = "Europe/Lisbon";

/** A search-result row (the coarse fields available before detail fetch). */
export interface SearchRow {
	id: string;
	url: string;
	title: string;
	/** "YYYY-MM-DD" (may be a past date — filtered out later). */
	date: string;
	venue: string;
	categories: string[];
	/** True when this row came from the venue-scoped search. */
	venueScoped: boolean;
}

/** Absolute URL for a relative Ticketline href. */
export const absoluteUrl = (href: string) =>
	href.startsWith("http") ? href : `${SITE}${href}`;

/** Parse a search page into rows, deduping by event id (last wins). */
export function parseSearch(html: string, venueScoped: boolean): SearchRow[] {
	const $ = cheerio.load(html);
	const rows: SearchRow[] = [];
	const seen = new Set<string>();
	$('li[itemscope][itemtype*="Event"]').each((_, el) => {
		const $li = $(el);
		const href = ($li.find('a[itemprop="url"]').attr("href") ?? "").trim();
		const idm = href.match(/-(\d+)$/);
		if (!idm) {
			return;
		}
		const id = idm[1] ?? "";
		if (seen.has(id)) {
			return;
		}
		seen.add(id);
		const categories = $li
			.find(".metadata.categories")
			.map((_, p) => $(p).text().trim())
			.get()
			.filter((s) => s.length > 0);
		rows.push({
			id,
			url: absoluteUrl(href),
			title: $li.find('p[itemprop="name"]').first().text().trim(),
			date: $li.find(".date[data-date]").attr("data-date") ?? "",
			venue: $li.find('p[itemprop="location"]').first().text().trim(),
			categories,
			venueScoped,
		});
	});
	return rows;
}

/** The resolved fields extracted from a leaf detail page's first session. */
export interface DetailInfo {
	title: string;
	/** "YYYY-MM-DD". */
	date: string;
	/** "HH:mm" or null. */
	time: string | null;
	venue: string;
	city: string;
	prices: string[];
}

/**
 * Parse a leaf detail page into {date,time,venue,city,prices}. Returns null
 * for festival "aggregator" pages (no resolvable session with a start time).
 */
export function parseDetail(html: string): DetailInfo | null {
	const $ = cheerio.load(html);
	const articleTitle = $("article.event_detail h2.title").first().text().trim();
	const session = $('li[itemprop="Event"]').first();
	if (session.length === 0) {
		return null;
	}
	const dateContent =
		session.find(".date[itemprop='startDate']").attr("content") ?? "";
	const datem = dateContent.match(/^(\d{4}-\d{2}-\d{2})/);
	if (!datem) {
		return null;
	}
	const timem = dateContent.match(/T(\d{2}:\d{2})$/);
	const city =
		session.find('span[itemprop="addressLocality"]').first().text().trim() ||
		session.find('span[itemprop="addressRegion"]').first().text().trim();
	const prices = session
		.find('span[itemprop="lowPrice"]')
		.map((_, s) => $(s).text().trim())
		.get()
		.filter((s) => s.length > 0);
	// The session name is sometimes more specific than the article header
	// (e.g. a "Bilhete Diário" run of a festival) — prefer it when present.
	const sessionName =
		session.find('div[itemprop="name"]').attr("content") ?? "";
	return {
		title: sessionName.trim() || articleTitle,
		date: datem[1] ?? "",
		time: timem ? (timem[1] ?? null) : null,
		venue: session.find('p.venue[itemprop="name"]').first().text().trim(),
		city,
		prices,
	};
}

/** Epoch (UTC seconds) for a "YYYY-MM-DD" + optional "HH:mm" in Lisbon. */
export function toEpoch(date: string, time: string | null): number | null {
	return ymdToEpoch(date, time);
}

/** Whether a card/venue string signals the Leiria municipality. */
export function mentionsLeiria(venue: string): boolean {
	return /leiria/i.test(venue);
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	/** Override "today" (start of day in Lisbon epoch) for date filtering. */
	now?: () => number;
	venueSearchUrl?: string;
}

const todayStart = () =>
	DateTime.now().setZone(LISBON_ZONE).startOf("day").toSeconds();

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
}

/**
 * Scrape Ticketline: run the text + venue searches, dedupe rows, detail-fetch
 * rows dated today-or-later, and keep only events resolved to Leiria. Past
 * runs and out-of-city shows are dropped. Per-row failures are counted, never
 * fatal.
 */
export async function scrape(
	deps: ScrapeDeps = { fetchText: defaultFetchText, sleep: defaultSleep },
): Promise<ScrapeResult> {
	const nowStart = deps.now ? deps.now() : todayStart();
	const venueSearchUrl = deps.venueSearchUrl ?? VENUE_SEARCH_URL;

	const { fetchPage } = createFetchGate({
		fetchText: deps.fetchText,
		sleep: deps.sleep,
		maxRequests: MAX_REQUESTS,
		delay: () => randomDelay(MIN_DELAY_MS, MAX_DELAY_MS - MIN_DELAY_MS + 1),
	});

	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;

	// Search phase.
	const byId = new Map<string, SearchRow>();
	const searchUrls = [SEARCH_URL, venueSearchUrl];
	for (const url of searchUrls) {
		try {
			const html = await fetchPage(url);
			pagesFetched++;
			for (const row of parseSearch(html, url.includes("venues="))) {
				if (!byId.has(row.id)) {
					byId.set(row.id, row);
				}
			}
		} catch (err) {
			failures++;
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	// Detail phase — only for rows starting today or later.
	const rows = [...byId.values()];
	const candidates = rows.filter((row) => {
		const start = toEpoch(row.date, null);
		return start == null || start >= nowStart;
	});

	const events: RawEvent[] = [];
	let cursor = 0;
	const worker = async () => {
		while (cursor < candidates.length) {
			const row = candidates[cursor];
			cursor++;
			if (!row) {
				continue;
			}
			let detail: DetailInfo | null = null;
			try {
				const html = await fetchPage(row.url);
				detail = parseDetail(html);
			} catch (err) {
				failures++;
				if (!firstError) {
					firstError = err instanceof Error ? err.message : String(err);
				}
				detail = null; // keep the row via the search-row fallback below
			}
			const raw = toRawEvent(row, detail);
			if (raw) {
				// Ticketline always yields a machine date; none means the date
				// is impossible ("30/02") — skip just this row, count it.
				if (raw.startAt == null) {
					failures++;
					firstError ??= `${row.url}: unparseable date "${detail?.date || row.date}"`;
					continue;
				}
				events.push(raw);
			}
		}
	};
	await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));

	return { events, failures, firstError, pagesFetched };
}

/** Build a RawEvent from a search row + its (optional) detail override. */
export function toRawEvent(
	row: SearchRow,
	detail: DetailInfo | null,
): RawEvent | null {
	const title = detail?.title || row.title;
	if (!title.trim()) {
		return null;
	}
	const date = detail?.date || row.date;
	const time = detail?.time ?? null;
	const startAt = toEpoch(date, time);

	// District scope: venue-scoped searches are deterministically Leiria;
	// otherwise trust the detail's resolved address (falling back to the
	// venue string). Then apply the district test (14 municipalities +
	// Leiria freguesias — district.ts is the authority).
	let city: string | null;
	if (row.venueScoped) {
		city = "Leiria";
	} else if (detail?.city) {
		city = detail.city;
	} else if (mentionsLeiria(row.venue)) {
		city = "Leiria";
	} else {
		return null; // not resolvable to any place → drop
	}
	if (!isLeiriaDistrict(city)) {
		return null;
	}

	const url = row.url;
	const slug = `tl-${row.id}`;
	return {
		title: title.trim(),
		slug,
		description: null,
		startAt,
		endAt: null,
		dateText: null, // Ticketline always yields a machine date
		venueName:
			detail?.venue?.trim() ||
			row.venue.split(",")[0]?.trim() ||
			"Local a definir",
		city,
		// No platform-name fallback; canonicalization happens at ingest.
		categories: row.categories,
		imageUrl: null,
		url,
		isFree: freeFromPrices(detail?.prices ?? []),
	};
}
