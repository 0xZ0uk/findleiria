import { DISTRICT_PLACE_NAMES, normalizePlace } from "./district";
import { defaultFetchText } from "./http";
import { createFetchGate } from "./lib/fetch-gate";
import { findJsonLdEvent } from "./lib/jsonld";
import { ymdToEpoch } from "./lib/pt-dates";
import { defaultSleep, randomDelay } from "./lib/timing";
import { loadState, saveState } from "./state";
import type { RawEvent } from "./types";

/**
 * festasearraiais.pt — breadth source (SLICE_7).
 *
 * National registry of popular festas / arraiais. Discovery is via sitemap:
 * `sitemap.xml` (a sitemapindex) → `sitemap-eventos.xml` (+ `-2.xml`), which
 * together enumerate every event page (~4100) with a daily-regenerated
 * `<lastmod>`. We honor robots.txt (everything allowed except `/api/`) — we
 * never call the cleaner `/api/events` JSON, we read the server-rendered
 * detail pages.
 *
 * Detail pages carry one schema.org Event JSON-LD block (any Event subtype,
 * bare, in an array or in `@graph`). Dates are date-only (`startDate`
 * 2024-08-30, `endDate` 2024-09-02) where `endDate` is INCLUSIVE — site copy
 * "(4 dias)" for 30 Aug→2 Sep counts 30, 31, 1, 2 — so the end lands at the
 * last day's 23:59:59 Lisbon. There are no JSON-LD categories → a title
 * heuristic picks Mercados e Feiras / Festivais / Tradição (canonicalized at
 * ingest).
 *
 * Incremental state (`state/festasearraiais.json`): `{ seen[] }` of every
 * fetched url. A seen url is never fetched again. A run is bounded by
 * `MAX_REQUESTS` (politeness) and the sitemap holds ~4100 urls, so the
 * backlog is worked off over several daily runs. Candidates are ordered
 * district-first (`rankCandidates`: a url slug naming a Leiria-district
 * concelho or parish goes before the rest), then newest-lastmod first. It is
 * a priority, not a filter: out-of-district urls are still fetched once the
 * district ones run out. Re-ingesting a known fingerprint is a no-op.
 */

export const SITE = "https://festasearraiais.pt";
export const SITEMAP_INDEX = `${SITE}/sitemap.xml`;
export const MAX_REQUESTS = 400;

export interface FestasState {
	/**
	 * Every event-page URL whose fetch RETURNED (a page without an event block
	 * counts; a fetch that threw does not). Unfetched and failed urls stay
	 * unseen so they are tried again on the next run — the sitemap holds ~4100
	 * urls and MAX_REQUESTS bounds each pass, so a cold run intentionally
	 * leaves work behind.
	 */
	seen: string[];
}

export const DEFAULT_STATE: FestasState = { seen: [] };

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Diagnostic: all event URLs discovered from the sitemaps (pre-gate). */
	discovered: number;
	/** Saves the new seen urls; the runner calls it after ingest (C7). Absent when discovery failed. */
	commit?: () => void;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	loadState: () => FestasState;
	saveState: (s: FestasState) => void;
	now: number;
}

/** The sitemapindex sub-sitemap URLs that carry event pages. */
export function parseSitemapIndex(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(
		/<loc>\s*(https:\/\/[^<]*?sitemap-eventos[^<]*?)\s*<\/loc>/g,
	)) {
		out.push(m[1]?.trim() ?? "");
	}
	return [...new Set(out.filter(Boolean))];
}

export interface SitemapEntry {
	url: string;
	lastmod: string;
}

/** Parse a single event sitemap: `<url>` blocks → `{loc, lastmod}` rows. */
export function parseEventSitemap(html: string): SitemapEntry[] {
	const out: SitemapEntry[] = [];
	const urlBlocks = html.match(/<url>[\s\S]*?<\/url>/g) ?? [];
	for (const block of urlBlocks) {
		const loc = block.match(/<loc>\s*([^<]*?)\s*<\/loc>/)?.[1]?.trim();
		const lastmod = block
			.match(/<lastmod>\s*([^<]*?)\s*<\/lastmod>/)?.[1]
			?.trim();
		if (loc) {
			out.push({ url: loc, lastmod: lastmod ?? "" });
		}
	}
	return out;
}

/** Stable id from the URL tail (`...-5574`). */
export function slugFor(url: string): string {
	const tail = decodeURIComponent(url.split("/eventos/")[1] ?? url);
	return `fe-${tail.replace(/^\/|\/$/g, "").replace(/\/+/g, ".")}`;
}

/** The event-page JSON-LD node (Event or any subtype); see lib/jsonld. */
export function parseDetailLd(html: string): Record<string, unknown> | null {
	return findJsonLdEvent(html);
}

interface LdLocation {
	name?: string;
	address?: {
		addressLocality?: string;
	} | null;
}

function asLocation(v: unknown): LdLocation | null {
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const address =
			o.address && typeof o.address === "object"
				? (o.address as Record<string, unknown>)
				: null;
		return {
			name: typeof o.name === "string" ? o.name : undefined,
			address: address
				? {
						addressLocality:
							typeof address.addressLocality === "string"
								? address.addressLocality
								: undefined,
					}
				: null,
		};
	}
	return null;
}

/** Title heuristic → raw category label (canonicalized at ingest). */
export function categoryForTitle(title: string): string {
	if (/^feira/i.test(title) || /mercado/i.test(title)) {
		return "Mercados e Feiras";
	}
	if (/festival/i.test(title)) {
		return "Festivais";
	}
	return "Tradição";
}

/** Merge JSON-LD → RawEvent. `startAt`/`endAt` null when dates are unparseable. */
export function toRawEvent(
	ld: Record<string, unknown>,
	url: string,
): RawEvent | null {
	const name = typeof ld.name === "string" ? ld.name.trim() : "";
	if (!name) {
		return null;
	}
	const startDate = typeof ld.startDate === "string" ? ld.startDate : "";
	const endDate = typeof ld.endDate === "string" ? ld.endDate : "";
	const startAt = ymdToEpoch(startDate);
	// endDate is INCLUSIVE (see the file header). Missing endDate → same-day slot.
	let endAt: number | null = null;
	if (startAt != null) {
		if (endDate) {
			const endStart = ymdToEpoch(endDate);
			// Verified against site copy: Vestiaria 28/08→08/09 renders
			// "12 dias" = 28..8 inclusive; Tremoceira 2024 30/08→02/09 renders
			// "(4 dias)" = 30,31,1,2. End of the last day, 23:59:59 Lisbon =
			// endDate 00:00 epoch + 86399s.
			endAt = endStart != null ? endStart + 86_399 : null;
		} else {
			endAt = startAt;
		}
	}

	const loc = asLocation(ld.location);
	const addressLocality = loc?.address?.addressLocality?.trim() || "";
	const venueName = loc?.name?.trim() || addressLocality || "Local a definir";
	// City: addressLocality is the concelho ("Porto de Mós", "Alcobaça") and
	// feeds the district gate. When a page lacks locality, fall back to the
	// venue name's first segment (e.g. "Tremoceira" from "Tremoceira,
	// Pedreiras") so the gate still sees place evidence.
	const city =
		addressLocality ||
		(loc?.name ? loc.name.split(",")[0]?.trim() : "") ||
		null;

	const imageRaw = ld.image;
	let imageUrl: string | null = null;
	if (typeof imageRaw === "string") {
		imageUrl = imageRaw;
	} else if (Array.isArray(imageRaw)) {
		const first = imageRaw.find((u) => typeof u === "string");
		imageUrl = (first as string | undefined) ?? null;
	} else if (imageRaw && typeof imageRaw === "object") {
		const u = (imageRaw as Record<string, unknown>).url;
		if (typeof u === "string") {
			imageUrl = u;
		}
	}

	return {
		title: name,
		slug: slugFor(url),
		description:
			typeof ld.description === "string" ? ld.description.trim() : null,
		startAt,
		endAt,
		dateText: null, // JSON-LD dates are machine-readable → no raw date text
		venueName,
		city,
		categories: [categoryForTitle(name)],
		imageUrl,
		url,
	};
}

const PLACE_SET: ReadonlySet<string> = new Set(DISTRICT_PLACE_NAMES);
const PLACE_MAX_WORDS = Math.max(
	...DISTRICT_PLACE_NAMES.map((n) => n.split(" ").length),
);

/**
 * How strongly a url slug points into the Leiria district: 2 when the place
 * part of the slug IS a district place name, 1 when it merely contains one,
 * 0 otherwise.
 *
 * Slugs read `festa-em-honra-de-<devotion>-<year>-<place>-<id>`, so the place
 * is what follows the year. Matching only there keeps devotions out ("Nossa
 * Senhora da Graça" is a parish name too, but the saint is not the place). A
 * slug with no year is matched whole. The exact-name tier ranks "…-2026-cortes"
 * above "…-2026-vilar-formoso", where "vilar" is a district parish but
 * Vilar Formoso is not. Place names come from district.ts, which is fed by
 * @events-tracker/api/places, so scope and ranking cannot drift apart.
 */
export function districtScore(url: string): 0 | 1 | 2 {
	const slug = decodeURIComponent(url.split("/eventos/")[1] ?? url)
		.replace(/^\/|\/$/g, "")
		.replace(/-\d+$/, "");
	const afterYear = /-(?:19|20)\d{2}-(.+)$/.exec(slug)?.[1] ?? slug;
	const words = normalizePlace(afterYear).split(" ").filter(Boolean);
	if (PLACE_SET.has(words.join(" "))) {
		return 2;
	}
	for (let i = 0; i < words.length; i++) {
		for (
			let len = Math.min(PLACE_MAX_WORDS, words.length - i);
			len >= 1;
			len--
		) {
			if (PLACE_SET.has(words.slice(i, i + len).join(" "))) {
				return 1;
			}
		}
	}
	return 0;
}

/**
 * Order sitemap entries for fetching: district-looking urls first (strongest
 * evidence first), then newest `lastmod`. Stable and total, so a cold start
 * spends its request budget in the district before anything else. Nothing is
 * dropped: out-of-district urls follow once the district ones are exhausted.
 */
export function rankCandidates(
	entries: readonly SitemapEntry[],
): SitemapEntry[] {
	return entries
		.map((e) => ({ e, score: districtScore(e.url) }))
		.sort((a, b) => b.score - a.score || b.e.lastmod.localeCompare(a.e.lastmod))
		.map((x) => x.e);
}

/**
 * Scrape festasearraiais: sitemap discovery → district-gated detail pages,
 * bounded by MAX_REQUESTS. `isInScope` is injectable for tests; production
 * uses `isLeiriaDistrict`.
 */
export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		loadState: () => loadState("festasearraiais", DEFAULT_STATE),
		saveState: (s) => saveState("festasearraiais", s),
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (city: string | null | undefined) => boolean = () => true,
): Promise<ScrapeResult> {
	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;

	const { fetchPage, capReached } = createFetchGate({
		fetchText: deps.fetchText,
		sleep: deps.sleep,
		maxRequests: MAX_REQUESTS,
		delay: () => randomDelay(),
	});

	// 1. sitemapindex → event sub-sitemaps
	const entry: SitemapEntry[] = [];
	try {
		const indexHtml = await fetchPage(SITEMAP_INDEX);
		pagesFetched++;
		const subSitemaps = parseSitemapIndex(indexHtml);
		for (const sub of subSitemaps) {
			const html = await fetchPage(sub);
			pagesFetched++;
			entry.push(...parseEventSitemap(html));
		}
	} catch (err) {
		return {
			events: [],
			failures: failures + 1,
			firstError: `sitemap discovery failed: ${err instanceof Error ? err.message : String(err)}`,
			pagesFetched,
			discovered: 0,
		};
	}
	if (entry.length === 0) {
		// Sitemaps with no event urls at all are broken discovery, not a quiet day
		// (zero NEW urls, i.e. everything already seen, is handled below).
		return {
			events: [],
			failures: failures + 1,
			firstError: `${SITEMAP_INDEX}: sitemaps parsed to zero event urls`,
			pagesFetched,
			discovered: 0,
		};
	}

	// Deduplicate by url, then order district-first so the request cap is spent
	// where events can pass the gate (see rankCandidates). Most of the sitemap
	// shares one lastmod, so lastmod alone cannot prioritise anything.
	const byUrl = new Map<string, SitemapEntry>();
	for (const e of entry) {
		byUrl.set(e.url, e);
	}
	const all = rankCandidates([...byUrl.values()]);

	// 2. incremental: fetch a url only when it was never fetched. Update
	// detection is fingerprint-based at ingest (a changed page re-ingests as
	// a no-op), so the sitemap lastmod is only a tiebreak within a priority tier.
	const state = deps.loadState();
	const seen = new Set(state.seen);
	const candidates = all.filter((e) => !seen.has(e.url));

	// 3. detail per candidate (bounded), district-gate on addressLocality.
	const events: RawEvent[] = [];
	const handled: string[] = [];
	for (const c of candidates) {
		if (capReached()) {
			break;
		}
		try {
			const html = await fetchPage(c.url);
			pagesFetched++;
			const ld = parseDetailLd(html);
			if (ld) {
				const raw = toRawEvent(ld, c.url);
				if (raw) {
					handled.push(c.url);
					if (isInScope(raw.city ?? raw.venueName)) {
						events.push(raw);
					}
				}
			} else {
				failures++;
				if (!firstError) {
					firstError = `no JSON-LD Event on ${c.url}`;
				}
			}
		} catch (err) {
			failures++;
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	// 4. Mark as seen, once ingest has committed (C7), the urls that parsed to
	// an event: emitted, or out of district. A seen url is never fetched
	// again. A fetch that threw, or a page with no (named) JSON-LD Event, is
	// NOT marked: it stays a candidate and is retried next run, at its place
	// in the district-first order, along with the rest of the unfetched
	// backlog — so a parser fix picks those pages up.
	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered: all.length,
		commit: () =>
			deps.saveState({ seen: [...new Set([...state.seen, ...handled])] }),
	};
}
