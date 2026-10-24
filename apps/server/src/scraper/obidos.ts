import { isLeiriaDistrict, normalizePlace } from "./district";
import { toEpochInLisbon } from "./fingerprint";
import { defaultFetchText } from "./http";
import { createFetchGate } from "./lib/fetch-gate";
import { textOf } from "./lib/html";
import { monthFromName } from "./lib/pt-dates";
import { defaultSleep, randomDelay } from "./lib/timing";
import { decodeEntities } from "./normalize";
import { loadState, saveState } from "./state";
import type { RawEvent } from "./types";

/**
 * obidos — depth source (SLICE_9).
 *
 * agenda.obidos.pt is the Óbidos municipal "Agenda Cultural" platform
 * (WordPress + Eventin). It is the largest culture program in the district
 * (FOLIO, Festival de Ópera de Óbidos, Mercado Medieval, Óbidos Vila Natal,
 * feiras, exposições) and the only live source scoped to the Óbidos concelho.
 * It covers all Óbidos freguesias (A-dos-Negros, A-da-Gorda, Amoreira,
 * Capeleira, Gaeiras, Olho Marinho, Pinhal, Sobral da Lagoa, Usseira, Vau…)
 * that no aggregator lists.
 *
 * Discovery follows the festasearraiais sitemap+`<lastmod>` watermark pattern.
 * The AIOSEO sitemap `etn-sitemap.xml` enumerates every `/evento/<slug>/`
 * detail page (95 urls verified live) with a daily-regenerated `<lastmod>`.
 * We honor robots.txt (only `/wp-admin/` disallowed) and read the
 * server-rendered detail pages. The WP Eventin REST API is auth-walled
 * (`rest_forbidden`), so detail parsing is HTML-only.
 *
 * Detail pages have a structured `date-location` block: two `<span>`s —
 * the human date range ("8 de Outubro, 2026 - 18 de Outubro, 2026") and the
 * venue/place ("Vila de Óbidos", "Amoreira, Óbidos"). The title is the
 * `h2.banner-title`; a description lives in `.etn-event-content-body`; the
 * `og:image` is the poster. Dates are Lisbon wall-clock, date-only (no time
 * in the copy) → startAt pins 00:00 Lisbon, endAt pins 23:59 on the last day.
 * When no machine-readable date is present the raw string stays in
 * `dateText` and startAt/endAt are null.
 *
 * Multi-day events (FOLIO, Festival de Ópera, Mercado Medieval, Óbidos Vila
 * Natal, feiras, year-long exposições) keep their real range (start day →
 * end day). Each agenda item is a single dated run; an event with several
 * separate sessions is one `RawEvent` for its primary/whole range — the
 * agenda does not split sessions, so there is no duplicate-emission risk.
 *
 * District gate: every event is an Óbidos-municipality programme (city
 * defaults to "Óbidos", a Leiria-district municipality, so it always gates
 * in). The venue string may name another concelho (trailing comma segment);
 * when that segment is itself a recognized Leiria-district place it becomes
 * the city, otherwise city stays "Óbidos". A venue that names a concelho
 * clearly outside the district gates out via `isInScope` (production wires
 * `isLeiriaDistrict`).
 *
 * Incremental state (`state/obidos.json`): `{ lastmod: { url → lastmod } }`
 * watermark of every fetched event page. A detail is fetched only when it is
 * new or its `<lastmod>` is newer than the stored one — steady state is one
 * sitemap fetch plus the handful of regen'd pages, so edits re-emit but
 * nothing is re-fetched wholesale and re-ingestion is a fingerprint no-op.
 */

export const SITE = "https://agenda.obidos.pt";
/** AIOSEO event sitemap: every `/evento/<slug>/`, `<lastmod>` per url. */
export const ETN_SITEMAP = `${SITE}/etn-sitemap.xml`;
export const MAX_REQUESTS = 400;
/** Description cap — the content body can be several paragraphs long. */
export const DESCRIPTION_MAX_CHARS = 600;

export interface ObidosState {
	/**
	 * Watermark: event url → the sitemap `<lastmod>` at which we last fetched
	 * its detail page. Missing url ⇒ never fetched; a stored value older than
	 * the sitemap's ⇒ changed since our last look, re-fetch.
	 */
	lastmod: Record<string, string>;
}

export const DEFAULT_STATE: ObidosState = { lastmod: {} };

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** All event urls discovered from the event sitemap (pre-gate). */
	discovered: number;
	/** Saves the advanced watermark; the runner calls it after ingest (C7). Absent when discovery failed. */
	commit?: () => void;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	loadState: () => ObidosState;
	saveState: (s: ObidosState) => void;
	now: number;
}

export interface SitemapEntry {
	url: string;
	lastmod: string;
}

/** Parse one event sitemap: `<url>` blocks → `{url, lastmod}` rows. */
export function parseEventSitemap(html: string): SitemapEntry[] {
	const out: SitemapEntry[] = [];
	const urlBlocks = html.match(/<url>[\s\S]*?<\/url>/g) ?? [];
	for (const block of urlBlocks) {
		const locCap =
			block.match(/<loc><!\[CDATA\[([\s\S]*?)\]\]><\/loc>/i) ||
			block.match(/<loc>\s*([^<]*?)\s*<\/loc>/i);
		const lastCap =
			block.match(/<lastmod><!\[CDATA\[([\s\S]*?)\]\]><\/lastmod>/i) ||
			block.match(/<lastmod>\s*([^<]*?)\s*<\/lastmod>/i);
		const loc = locCap?.[1];
		if (loc) {
			out.push({
				url: loc.trim(),
				lastmod: (lastCap?.[1] ?? "").trim(),
			});
		}
	}
	return out;
}

/** Stable source id from the event slug. */
export function slugFor(url: string): string {
	const tail = (url.split("/evento/")[1] ?? url).replace(/^\/+|\/+$/g, "");
	return `ob-${tail.replace(/\/+/g, ".")}`;
}

export interface ParsedDetail {
	title: string | null;
	dateText: string | null;
	venue: string | null;
	description: string | null;
	imageUrl: string | null;
}

/**
 * Parse the detail-page banner: `h2.banner-title` (title), the
 * `date-location` spans (dateText + venue), `.etn-event-content-body`
 * (description) and `og:image` (poster).
 */
export function parseDetail(html: string): ParsedDetail {
	const titleMatch = html.match(/<h2 class="banner-title">([\s\S]*?)<\/h2>/i);
	let title: string | null = null;
	if (titleMatch) {
		title = cleanText(titleMatch[1] ?? "") || null;
	}
	if (!title) {
		const og = html.match(/<meta property="og:title" content="([^"]*)"/);
		if (og) {
			title =
				decodeEntities(
					(og[1] ?? "").replace(/\s*-\s*Agenda Cultural.*$/is, ""),
				).trim() || null;
		}
	}

	let dateText: string | null = null;
	let venue: string | null = null;
	const block = html.match(/<div class="date-location">([\s\S]*?)<\/div>/is);
	if (block) {
		const spans = [...(block[1] ?? "").matchAll(/<span>([\s\S]*?)<\/span>/gis)]
			.map((m) => cleanText(m[1] ?? ""))
			.filter(Boolean);
		dateText = spans[0] ?? null;
		venue = spans[1] ?? null;
	}

	let description: string | null = null;
	const body = html.match(
		/<div class="etn-event-content-body">([\s\S]*?)<div class="event-share">/is,
	);
	if (body) {
		const text = cleanText(body[1] ?? "");
		if (text) {
			description = text.slice(0, DESCRIPTION_MAX_CHARS);
		}
	}

	const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/);
	const imageUrl = ogImage?.[1]?.trim() || null;

	return { title, dateText, venue, description, imageUrl };
}

/**
 * Display text of an HTML fragment. The site writes apostrophes as curly
 * entities; the agenda has always shown them straight, so fold them before
 * the canonical decode.
 */
function cleanText(html: string): string {
	return textOf(html.replace(/&#8217;|&rsquo;|&lsquo;/g, "'"));
}

export interface ParsedDate {
	startYear: number;
	startMonth: number;
	startDay: number;
	endYear: number;
	endMonth: number;
	endDay: number;
}

const MONTH_RE = "[a-zA-Zçãéú]+";

/**
 * Parse the site's date copy: "13 de Junho, 2026" or the range
 * "27 de Novembro, 2026 - 3 de Janeiro, 2027" (cross-year ok). Returns null
 * when the text is not a recognizable Portuguese day(/day-range) with year.
 */
export function parseDate(text: string): ParsedDate | null {
	const norm = text.replace(/\s+/g, " ").replace(/[–—]/g, "-").trim();
	const m = new RegExp(
		`^(\\d{1,2})\\s+de\\s+(${MONTH_RE}),\\s*(\\d{4})(?:\\s*-\\s*(\\d{1,2})\\s+de\\s+(${MONTH_RE}),\\s*(\\d{4}))?$`,
		"i",
	).exec(norm);
	if (!m) {
		return null;
	}
	const startMonth = monthFromName(m[2] ?? "");
	const endMonth = m[5] ? monthFromName(m[5] ?? "") : startMonth;
	if (startMonth == null || endMonth == null) {
		return null;
	}
	const startYear = Number(m[3]);
	const endYear = m[6] ? Number(m[6]) : startYear;
	return {
		startYear,
		startMonth,
		startDay: Number(m[1]),
		endYear,
		endMonth,
		endDay: Number(m[4] ?? m[1]),
	};
}

/** "A definir" / empty venue ⇒ unknown → the task's Óbidos city placeholder. */
const UNKNOWN_VENUE = /^a\s*(definir|confirmar)$/i;

/**
 * Portuguese concelhos OUTSIDE the district that still show up as a comma tail
 * on the Óbidos agenda ("Teatro, Lisboa"). The district's own neighbours plus
 * the usual suspects are enough: a recognized foreign concelho is surfaced as
 * the city so the DISTRICT GATE drops the event, instead of parking a Lisboa
 * event in Óbidos and reporting it as local.
 */
const OUT_OF_DISTRICT_CONCELHOS = [
	"agueda",
	"albergaria-a-velha",
	"almada",
	"amadora",
	"aveiro",
	"barcelos",
	"beja",
	"braga",
	"braganca",
	"cascais",
	"castelo branco",
	"coimbra",
	"covilha",
	"espinho",
	"evora",
	"faro",
	"figueira da foz",
	"guarda",
	"guimaraes",
	"leca da palmeira",
	"lisboa",
	"loures",
	"maia",
	"matosinhos",
	"montijo",
	"oeiras",
	"olhao",
	"ovar",
	"penafiel",
	"portimao",
	"porto",
	"povoa de varzim",
	"santarem",
	"setubal",
	"sintra",
	"tomar",
	"torres vedras",
	"valongo",
	"viana do castelo",
	"vila do conde",
	"vila franca de xira",
	"vila nova de famalicao",
	"vila nova de gaia",
	"vila real",
	"viseu",
] as const;

const OUT_OF_DISTRICT_SET = new Set<string>(OUT_OF_DISTRICT_CONCELHOS);

/** True when `place` is a recognized concelho outside the Leiria district. */
export function isOutOfDistrictConcelho(place: string): boolean {
	return OUT_OF_DISTRICT_SET.has(normalizePlace(place));
}

/** Resolve venueName + city from the detail's venue string. Unknown → "Óbidos". */
export function resolveVenue(venue: string | null): {
	venueName: string;
	city: string;
} {
	const raw = venue?.trim() || "";
	if (!raw || UNKNOWN_VENUE.test(raw)) {
		return { venueName: "Óbidos", city: "Óbidos" };
	}
	// The venue may carry the concelho after a comma ("Amoreira, Óbidos",
	// "Aldeia dos Pescadores, Vau" where Vau is an Óbidos freguesia). A
	// trailing segment resolving to an in-district place becomes the city; so
	// does a recognized OUT-of-district concelho ("Teatro, Lisboa") — the gate
	// then drops it instead of us claiming Lisbon for Óbidos. Any other tail is
	// an Óbidos freguesia we cannot map, so the concelho Óbidos stands.
	let city = "Óbidos";
	const parts = raw
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	const last = parts[parts.length - 1] ?? "";
	if (last && (isLeiriaDistrict(last) || isOutOfDistrictConcelho(last))) {
		city = last;
	}
	return { venueName: raw, city };
}

/** Title heuristic → raw category label (canonicalized at ingest). */
export function categoryForTitle(title: string): string {
	// Normalize first: "ATELIÊ" must match /atelie/, "Exposições" /exposi/.
	const t = normalizePlace(title);
	if (/exposi|mostra|colec/i.test(t)) {
		return "Exposições";
	}
	if (/festival|folio|\bfol\b|semana/i.test(t)) {
		return "Festivais";
	}
	if (/mercado|feira/i.test(t)) {
		return "Mercados e Feiras";
	}
	if (/oficina|atelier|atelie|workshop|kamishi/i.test(t)) {
		return "Oficinas";
	}
	if (/festa|romaria/i.test(t)) {
		return "Tradição";
	}
	return "Outros";
}

/** Merge a parsed detail into a RawEvent. Null when untitled/past/undatable. */
export function toRawEvent(
	parsed: ParsedDetail,
	url: string,
	nowUnix: number,
): RawEvent | null {
	const title = parsed.title;
	if (!title) {
		return null;
	}
	const dateText = parsed.dateText;
	let startAt: number | null = null;
	let endAt: number | null = null;
	let machineDate = false;
	const date = dateText ? parseDate(dateText) : null;
	if (date) {
		try {
			startAt = toEpochInLisbon(
				date.startYear,
				date.startMonth,
				date.startDay,
				0,
				0,
			);
			endAt = toEpochInLisbon(date.endYear, date.endMonth, date.endDay, 23, 59);
			machineDate = true;
		} catch {
			// invalid calendar day — fall through to undated placeholder
		}
	}
	if (machineDate) {
		// Past events drop (never roll forward to invent a future year).
		if (endAt != null && endAt < nowUnix) {
			return null;
		}
	}

	const { venueName, city } = resolveVenue(parsed.venue);

	return {
		title,
		slug: slugFor(url),
		description: parsed.description,
		startAt,
		endAt,
		// no machine-readable date → keep the raw string; ingest pins a
		// placeholder. With a parsed date we leave it null (machine-readable).
		dateText: machineDate ? null : dateText,
		venueName,
		city,
		categories: [categoryForTitle(title)],
		imageUrl: parsed.imageUrl,
		url,
	};
}

/**
 * Scrape agenda.obidos.pt: event sitemap discovery → district-gated detail
 * pages, watermarked by `<lastmod>`. `isInScope` is injectable for tests;
 * production wires `isLeiriaDistrict` (central registry).
 */
export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		loadState: () => loadState("obidos", DEFAULT_STATE),
		saveState: (s) => saveState("obidos", s),
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

	// 1. event sitemap → every detail url + its lastmod watermark
	let entries: SitemapEntry[] = [];
	try {
		const html = await fetchPage(ETN_SITEMAP);
		pagesFetched++;
		entries = parseEventSitemap(html);
	} catch (err) {
		return {
			events: [],
			failures: failures + 1,
			firstError: `${ETN_SITEMAP}: ${err instanceof Error ? err.message : String(err)}`,
			pagesFetched,
			discovered: 0,
		};
	}
	if (entries.length === 0) {
		// A sitemap with no event urls at all is broken discovery, not a quiet day
		// (zero CHANGED urls, i.e. an unmoved watermark, is handled below).
		return {
			events: [],
			failures: failures + 1,
			firstError: `${ETN_SITEMAP}: sitemap parsed to zero event urls`,
			pagesFetched,
			discovered: 0,
		};
	}
	const byUrl = new Map<string, SitemapEntry>();
	for (const e of entries) {
		byUrl.set(e.url, e);
	}
	const all = [...byUrl.values()].sort((a, b) =>
		b.lastmod.localeCompare(a.lastmod),
	);

	// 2. fetch only details that are new or whose lastmod advanced.
	const state = deps.loadState();
	const watermark = { ...state.lastmod };
	const fetchList = all.filter(
		(e) => watermark[e.url] == null || watermark[e.url] !== e.lastmod,
	);

	// 3. detail per candidate (bounded), district-gate on the resolved city.
	const events: RawEvent[] = [];
	const fetched: SitemapEntry[] = [];
	for (const c of fetchList) {
		if (capReached()) {
			break;
		}
		try {
			const html = await fetchPage(c.url);
			pagesFetched++;
			const parsed = parseDetail(html);
			const raw = toRawEvent(parsed, c.url, deps.now);
			if (raw && isInScope(raw.city)) {
				events.push(raw);
			}
			// Record the watermark only for a page that parsed to an event
			// (emitted, out of district, or merely over), so a changed page is
			// retried, a dead url keeps surfacing as a failure, and a page with
			// no title is picked up again once the parser handles it (C7).
			if (raw || toRawEvent(parsed, c.url, Number.NEGATIVE_INFINITY) !== null) {
				watermark[c.url] = c.lastmod;
				fetched.push(c);
			}
		} catch (err) {
			failures++;
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	// 4. persist the watermark for those urls — deferred (C7): the runner
	// saves it only after ingest committed.
	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered: all.length,
		commit: () => {
			if (fetched.length > 0) deps.saveState({ lastmod: watermark });
		},
	};
}
