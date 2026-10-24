import { defaultFetchText } from "./http";
import { findJsonLdEvent, offerPrices } from "./lib/jsonld";
import { defaultSleep, randomDelay } from "./lib/timing";
import { freeFromPrices } from "./normalize";
import type { RawEvent } from "./types";

/**
 * Shotgun source (SLICE_7).
 *
 * shotgun.live is the ticketing home of Leiria's club scene (Stereogun &
 * friends). There is no Leiria city page — the region page
 * `/en/cities/center-pt` mixes events across "Centro" Portugal, so the
 * Leiria-district decision happens per event using the venue locality from
 * the detail page's schema.org JSON-LD (MusicEvent with PostalAddress).
 *
 * Pipeline:
 *   1. fetch the region listing → collect /en/events/<slug> links
 *   2. fetch each detail page → parse the MusicEvent JSON-LD
 *   3. keep events whose venue address locality is in the Leiria district
 *      (district.ts is the authority)
 *
 * Notes from live recon:
 *   - the checkpoint page ("Vercel Security Checkpoint", HTTP 429) shows up
 *     intermittently for plain fetches; http.ts treats 429 as retryable with
 *     cooldown. The listing/detail HTML itself is fully server-rendered —
 *     no browser needed when the fetch gets through.
 *   - the listing has no pagination that works (?page=N returns page 1);
 *     everything is on the first page (~10-20 events).
 *   - times are UTC ISO in JSON-LD ("2026-09-04T21:00:00.000Z") → use the
 *     epoch directly (no Lisbon wall-clock reconstruction needed).
 *   - "Centro" as a locality means the venue has no resolvable city → drop.
 */

export const SITE = "https://shotgun.live";
export const REGION_URL = `${SITE}/en/cities/center-pt`;

export const MAX_REQUESTS = 40;

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Diagnostic: slugs seen in the listing. */
	listedSlugs: string[];
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
}

interface EventLd {
	"@type"?: string | string[];
	name?: string;
	startDate?: string;
	endDate?: string;
	description?: string;
	image?: string | { url?: string };
	location?: {
		name?: string;
		address?: {
			addressLocality?: string;
			addressRegion?: string;
			streetAddress?: string;
		} | null;
	} | null;
	url?: string;
	offers?: unknown;
}

/** Extract the schema.org Event/MusicEvent JSON-LD object from a detail page. */
export function parseDetailLd(html: string): EventLd | null {
	return findJsonLdEvent<EventLd>(html);
}

/** Slug for a RawEvent from the listing slug (already URL-safe). */
export const slugFor = (slug: string) => `sg-${slug}`;

/** Parse the region listing: every /en/events/<slug> link on the page. */
export function parseListingLinks(html: string): string[] {
	const out = new Set<string>();
	for (const m of html.matchAll(/href="\/en\/events\/([a-z0-9-]+)"/g)) {
		const slug = m[1];
		if (slug && slug.length > 2) {
			out.add(slug);
		}
	}
	return [...out];
}

/** Epoch from Shotgun's UTC ISO ("2026-09-04T21:00:00.000Z"). */
function isoUtcToEpoch(iso: string | undefined): number | null {
	if (!iso) {
		return null;
	}
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Merge listing slug + detail JSON-LD into a RawEvent (null when out of scope). */
export function toRawEvent(slug: string, ld: EventLd | null): RawEvent | null {
	if (!ld) {
		return null;
	}
	const title = ld.name?.trim();
	if (!title) {
		return null;
	}
	const startAt = isoUtcToEpoch(ld.startDate);
	if (startAt == null) {
		return null;
	}
	const endAt = isoUtcToEpoch(ld.endDate);

	// District decision happens here: the venue locality (or venue name, or
	// the embedded street address) must resolve to the Leiria district.
	const locality = ld.location?.address?.addressLocality?.trim() || "";
	const venueName = ld.location?.name?.trim() || "";
	const street = ld.location?.address?.streetAddress?.trim() || "";
	void street; // part of caller-supplied evidence via city fallback

	// Out-of-district events are dropped by the caller (needs district.ts);
	// here we only mark the resolved city so the caller can decide.
	const city = locality || null;

	return {
		title,
		slug: slugFor(slug),
		description: ld.description?.trim() || null,
		startAt,
		endAt,
		dateText: null,
		venueName: venueName || "Local a definir",
		city,
		// No platform-name category: Shotgun rows carry real categories from
		// JSON-LD when present; canonicalization happens at ingest.
		categories: [],
		imageUrl: typeof ld.image === "string" ? ld.image : (ld.image?.url ?? null),
		url: ld.url?.trim() || `${SITE}/en/events/${slug}`,
		isFree: freeFromPrices(offerPrices(ld)),
	};
}

/**
 * Scrape the Shotgun Centro region: listing → per-event detail fetches
 * (bounded, per-card resilient) → keep only Leiria-district venues via
 * isLeiriaDistrict on the JSON-LD address locality (falling back to venue
 * name evidence, which the caller checks). Also returns the dropped slugs
 * count for observability.
 */
export async function scrape(
	deps: ScrapeDeps = { fetchText: defaultFetchText, sleep: defaultSleep },
	/** injected for tests; production: isLeiriaDistrict from district.ts */
	isInScope: (city: string | null | undefined) => boolean = () => true,
): Promise<ScrapeResult> {
	let requests = 0;
	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;

	const fetchPage = async (url: string): Promise<string> => {
		if (requests >= MAX_REQUESTS) {
			throw new Error(`request cap ${MAX_REQUESTS} reached`);
		}
		requests++;
		await deps.sleep(randomDelay(500, 700));
		return deps.fetchText(url);
	};

	// 1. listing
	let listedSlugs: string[] = [];
	try {
		const html = await fetchPage(REGION_URL);
		pagesFetched++;
		listedSlugs = parseListingLinks(html);
	} catch (err) {
		return {
			events: [],
			failures: failures + 1,
			firstError: err instanceof Error ? err.message : String(err),
			pagesFetched,
			listedSlugs,
		};
	}

	if (listedSlugs.length === 0) {
		// A Vercel checkpoint / challenge page is served with HTTP 200 and parses
		// to nothing: the region listing is never really empty, so report it.
		return {
			events: [],
			failures: failures + 1,
			firstError: `${REGION_URL}: listing parsed to zero events (checkpoint or markup change?)`,
			pagesFetched,
			listedSlugs,
		};
	}

	// 2. detail per slug (bounded concurrency)
	const events: RawEvent[] = [];
	let cursor = 0;
	const worker = async () => {
		while (cursor < listedSlugs.length) {
			const slug = listedSlugs[cursor];
			cursor++;
			if (!slug) {
				continue;
			}
			try {
				const html = await fetchPage(`${SITE}/en/events/${slug}`);
				pagesFetched++;
				const ld = parseDetailLd(html);
				const raw = toRawEvent(slug, ld);
				if (raw && isInScope(raw.city ?? raw.venueName)) {
					events.push(raw);
				}
			} catch (err) {
				failures++;
				if (!firstError) {
					firstError = err instanceof Error ? err.message : String(err);
				}
			}
		}
	};
	await Promise.all(Array.from({ length: 3 }, worker));

	return { events, failures, firstError, pagesFetched, listedSlugs };
}
