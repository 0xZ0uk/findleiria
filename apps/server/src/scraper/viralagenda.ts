import * as cheerio from "cheerio";
import { DateTime } from "luxon";
import { isLeiriaDistrict } from "./district";
import { defaultFetchText } from "./http";
import { createFetchGate } from "./lib/fetch-gate";
import { findJsonLdEvent } from "./lib/jsonld";
import { ymdToEpoch } from "./lib/pt-dates";
import { defaultSleep, randomDelay } from "./lib/timing";
import { detectFree } from "./normalize";
import type { RawEvent } from "./types";

/**
 * Viral Agenda source (SLICE_5 — nightlife discovery).
 *
 * Viral Agenda serves Leiria-district events under two facet scopes:
 *   district-wide:  /pt/leiria/<category>
 *   city-scoped:    /pt/leiria/leiria/<category>
 * Both are fully server-rendered lists of `<li id="c<id>" data-url=…>` cards.
 * Pagination params (?p, ?d, ?date) all echo page 1 on this site, so we do NOT
 * paginate — we scrape MULTIPLE category facets instead to broaden coverage.
 *
 * Event detail pages embed schema.org JSON-LD with the authoritative
 * name/startDate/endDate/location.address.addressLocality/description, which
 * we prefer over the card fields. City scope: only events whose address
 * locality (or listing node) is Leiria are ingested.
 *
 * Time-placeholder handling: card `.viral-event-hour` is "N/D" and the card's
 * `data-date-start` reads "T00:59" when the site has no real start time —
 * both mean "unspecified". We treat those as no-time, pinning start_at to the
 * DATE at 00:00 Lisbon (NOT the 00:59 token). The detail startDate, when it
 * carries a real time, overrides the card entirely.
 */

export const SITE = "https://www.viralagenda.com";

/** Category facets scraped on both the district and the city scope. */
export const DEFAULT_FACETS = [
	"clubbing",
	"concerts",
	"festivals",
	"tradition",
	"meetings",
	"conferences",
] as const;

const SCOPES = ["district", "city"] as const;

export const MAX_REQUESTS = 260;
export const DETAIL_CONCURRENCY = 3;
export const MIN_DELAY_MS = 500;
export const MAX_DELAY_MS = 900;
export const LISBON_ZONE = "Europe/Lisbon";

/** A listing-page card (fine-grained fields available without detail fetch). */
export interface ListingCard {
	id: string;
	url: string;
	title: string;
	city: string | null;
	/** Every municipality node listed for the card (multi-city festivals). */
	cities: string[];
	venue: string;
	categories: string[];
	/** ISO start/end datetimes (may be a "T00:59" placeholder). */
	dateStart: string | null;
	dateEnd: string | null;
	hasTime: boolean;
	imageUrl: string | null;
}

export const districtUrl = (category: string) =>
	`${SITE}/pt/leiria/${category}`;
export const cityUrl = (category: string) =>
	`${SITE}/pt/leiria/leiria/${category}`;

/** Listing URLs for every facet × scope. Order is stable for the request gate. */
export function listingUrls(facets: readonly string[]): string[] {
	const urls: string[] = [];
	for (const scope of SCOPES) {
		for (const category of facets) {
			urls.push(scope === "city" ? cityUrl(category) : districtUrl(category));
		}
	}
	return urls;
}

/** A time token that is NOT a real start time ("N/D", "00:59", empty). */
export function isPlaceholderTime(hour: string): boolean {
	const h = hour.trim();
	return h === "" || h === "N/D" || h === "T00:59" || h === "00:59";
}

/**
 * Parse every event card out of a Viral Agenda listing page. `city` is the
 * first municipality node; `cities` holds all of them (multi-municipality
 * events). A card with `hasTime:false` has a placeholder start time — the date
 * is still usable, pinned to 00:00.
 */
export function parseListing(html: string): ListingCard[] {
	const $ = cheerio.load(html);
	const cards: ListingCard[] = [];
	$("li[data-id]").each((_, el) => {
		const $li = $(el);
		const id = ($li.attr("data-id") ?? "").trim();
		const dataUrl = ($li.attr("data-url") ?? "").trim();
		if (!id || !dataUrl) {
			return;
		}
		const title = $li
			.find(".viral-event-title .viral-linked span")
			.first()
			.text()
			.trim();
		const hour = $li.find(".viral-event-hour").first().text().trim();
		const cities = $li
			.find("a.node-name span")
			.map((_, s) => $(s).text().trim())
			.get()
			.filter((s) => s.length > 0);
		const categories = [
			...new Set(
				$li
					.find('a[title="Ver eventos desta categoria"]')
					.map((_, a) => $(a).text().trim())
					.get()
					.filter((s) => s.length > 0),
			),
		];
		const imageUrl =
			$li.find(".viral-event-image").attr("data-img") ??
			$li.find(".viral-event-image img").first().attr("src") ??
			null;
		cards.push({
			id,
			url: dataUrl.startsWith("http") ? dataUrl : `${SITE}${dataUrl}`,
			title,
			city: cities[0] ?? null,
			cities,
			venue: $li.find("a.viral-event-place span").first().text().trim(),
			categories,
			dateStart: $li.attr("data-date-start") ?? null,
			dateEnd: $li.attr("data-date-end") ?? null,
			hasTime: !isPlaceholderTime(hour),
			imageUrl,
		});
	});
	return cards;
}

/** Fields exposed by the detail page's schema.org JSON-LD block. */
export interface DetailEvent {
	name: string | null;
	startDate: string | null;
	endDate: string | null;
	image: string | null;
	description: string | null;
	venue: string | null;
	city: string | null;
}

/**
 * Parse the page's schema.org event JSON-LD (Event or any subtype such as
 * MusicEvent/Festival, bare, in an array, or inside `@graph`) into the detail
 * fields. Null when the page carries no event block.
 */
export function parseDetail(html: string): DetailEvent | null {
	const ev = findJsonLdEvent<{
		name?: unknown;
		startDate?: unknown;
		endDate?: unknown;
		image?: unknown;
		description?: unknown;
		location?: { name?: unknown; address?: { addressLocality?: unknown } };
	}>(html);
	if (!ev) {
		return null;
	}
	const loc = ev.location;
	const addr = loc?.address;
	return {
		name: typeof ev.name === "string" ? ev.name : null,
		startDate: typeof ev.startDate === "string" ? ev.startDate : null,
		endDate: typeof ev.endDate === "string" ? ev.endDate : null,
		image: typeof ev.image === "string" ? ev.image : null,
		description: typeof ev.description === "string" ? ev.description : null,
		venue: typeof loc?.name === "string" ? loc.name : null,
		city:
			typeof addr?.addressLocality === "string" ? addr.addressLocality : null,
	};
}

/**
 * Epoch (UTC seconds) for an ISO string. Datetimes carrying an offset are
 * converted as absolute instants; date-only values are pinned to midnight
 * Europe/Lisbon. Returns null when unparseable.
 */
export function isoToEpoch(iso: string | null | undefined): number | null {
	if (!iso) {
		return null;
	}
	const s = iso.trim();
	if (!s) {
		return null;
	}
	if (s.includes("T")) {
		const dt = DateTime.fromISO(s, { zone: LISBON_ZONE });
		return dt.isValid ? Math.round(dt.toSeconds()) : null;
	}
	return ymdToEpoch(s);
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	/** Override facet set (used by offline tests to shrink the fan-out). */
	facets?: readonly string[];
}

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
}

/** Build a RawEvent from a listing card + its (optional) detail override. */
export function toRawEvent(
	card: ListingCard,
	detail: DetailEvent | null,
): RawEvent | null {
	// District scope: detail address locality wins; fall back to card node
	// names. Any of the 14 district municipalities (or Leiria freguesias)
	// passes — see district.ts for the authoritative list.
	const cardIsDistrict = card.cities.some((c) => isLeiriaDistrict(c));
	const detailIsDistrict = isLeiriaDistrict(detail?.city);
	if (!cardIsDistrict && !detailIsDistrict) {
		return null;
	}

	let startAt: number | null = null;
	let endAt: number | null = null;
	// TIME POLICY: the listing card's `data-date-*` is the site's own UI time —
	// what users see. The detail JSON-LD startDate is systematically ONE HOUR
	// EARLY during DST (WEST): VA's generator emits UTC-shifted wall times with
	// a stale +01:00 label (verified 2026-09-02: card 21:30+01:00 vs JSON-LD
	// 20:30+01:00 for the same event; leiriagenda/eventbrite corroborate the
	// card). So when the card carries a real time it wins; the detail time is
	// only used when the card has a placeholder (00:59 / N/D).
	const cardHasRealTime = card.hasTime && !!card.dateStart;
	const detailStart = isoToEpoch(detail?.startDate);
	if (cardHasRealTime) {
		startAt = isoToEpoch(card.dateStart);
	} else if (detailStart !== null) {
		startAt = detailStart;
	} else if (card.dateStart) {
		startAt = ymdToEpoch(card.dateStart);
	}
	if (!startAt && card.dateStart) {
		// last resort: the date alone, i.e. resolve even a placeholder time date
		startAt = ymdToEpoch(card.dateStart);
	}

	const detailEnd = isoToEpoch(detail?.endDate);
	const cardEnd =
		card.dateEnd && card.dateEnd !== card.dateStart ? card.dateEnd : null;
	if (cardHasRealTime && cardEnd) {
		endAt = isoToEpoch(cardEnd);
	} else if (detailEnd !== null && detailEnd !== startAt) {
		endAt = detailEnd;
	} else if (cardEnd) {
		endAt = card.hasTime ? isoToEpoch(cardEnd) : ymdToEpoch(cardEnd);
	}
	// Sanity: an end before its start (e.g. a date-only detail endDate that
	// resolves to midnight of the start day) is noise — drop it.
	if (endAt != null && startAt != null && endAt < startAt) {
		endAt = null;
	}

	const city = detail?.city ?? card.city;
	const title = detail?.name?.trim() || card.title.trim();
	const description = detail?.description?.trim() || null;
	return {
		title,
		slug: `va-${card.id}`,
		description,
		startAt,
		endAt,
		dateText: null, // always a machine-readable date → no undated path
		venueName: detail?.venue?.trim() || card.venue.trim() || "Local a definir",
		city: city ? city.trim() : "Leiria",
		// No platform-name fallback; canonicalization happens at ingest.
		categories: card.categories,
		imageUrl: detail?.image ?? card.imageUrl,
		url: card.url,
		isFree: detectFree(`${title}. ${description ?? ""}`),
	};
}

/**
 * Scrape Viral Agenda: fetch every category facet on both scopes, dedupe cards
 * by id, then detail-fetch each card with per-card resilience and a Leiria
 * city filter. Per-card failures are counted, never fatal — a partial run beats
 * no run. Respects the shared 429-aware backoff in http.ts.
 */
export async function scrape(
	deps: ScrapeDeps = { fetchText: defaultFetchText, sleep: defaultSleep },
): Promise<ScrapeResult> {
	const facets = deps.facets?.length ? deps.facets : DEFAULT_FACETS;
	const urlQueue = listingUrls(facets);
	const { fetchPage } = createFetchGate({
		fetchText: deps.fetchText,
		sleep: deps.sleep,
		maxRequests: MAX_REQUESTS,
		delay: () => randomDelay(MIN_DELAY_MS, MAX_DELAY_MS - MIN_DELAY_MS + 1),
	});

	const cardsById = new Map<string, ListingCard>();
	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;

	// Listing phase (best-effort across facets).
	for (const url of urlQueue) {
		try {
			const html = await fetchPage(url);
			pagesFetched++;
			for (const card of parseListing(html)) {
				if (!cardsById.has(card.id)) {
					cardsById.set(card.id, card);
				}
			}
		} catch (err) {
			failures++;
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	// Broken markup / challenge page parses to zero cards across every facet:
	// that is a failure, not a quiet day.
	if (cardsById.size === 0) {
		failures++;
		firstError ??= "listing parsed to zero cards across all facets";
	}

	// Detail phase.
	const cards = [...cardsById.values()];
	const events: RawEvent[] = [];
	let cursor = 0;
	const worker = async () => {
		while (cursor < cards.length) {
			const card = cards[cursor];
			cursor++;
			if (!card) {
				continue;
			}
			let detail: DetailEvent | null = null;
			try {
				const html = await fetchPage(card.url);
				detail = parseDetail(html);
			} catch (err) {
				failures++;
				if (!firstError) {
					firstError = err instanceof Error ? err.message : String(err);
				}
				detail = null; // keep the card via the listing-only fallback below
			}
			const raw = toRawEvent(card, detail);
			if (raw) {
				// A card whose date exists but resolves to nothing carries an
				// impossible calendar date: skip just this card, count it.
				if (raw.startAt == null && card.dateStart) {
					failures++;
					firstError ??= `${card.url}: impossible date "${card.dateStart}"`;
					continue;
				}
				events.push(raw);
			}
		}
	};
	await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));

	return { events, failures, firstError, pagesFetched };
}
