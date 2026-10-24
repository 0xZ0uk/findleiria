import { isLeiriaDistrict } from "./district";
import { errorMessage } from "./errors";
import { toEpochInLisbonOrNull } from "./fingerprint";
import { defaultFetchText } from "./http";
import { textOf } from "./lib/html";
import { monthFromPrefix } from "./lib/pt-dates";
import { defaultSleep, randomDelay } from "./lib/timing";
import { decodeEntities } from "./normalize";
import { loadState, saveState } from "./state";
import type { RawEvent } from "./types";

/**
 * municipal — breadth source (SLICE_9 Tier 1).
 *
 * Seven Leiria-district councils run the same municipal CMS (wm-smile). Each
 * publishes an "agenda"/"eventos" listing whose items link to
 * `/…/evento/<slug>` detail pages carrying a structured `EventDetail` widget:
 * a `dates` chip, an `addtocalendar` block with machine-readable
 * `atc_date_start` / `atc_date_end`, a `Local:` venue field and a `summary`
 * body. One parser therefore covers all seven.
 *
 *   site            listing                                        paginator          pages
 *   Marinha Grande  /comunicar/eventos/todos-os-eventos             events_list_13      44
 *   Nazaré          /visitar/todos-os-eventos                       events_list_73      71
 *   Batalha         /municipe/comunicacao/agenda-cultural           —                    1
 *   Alvaiázere      /municipio/comunicacao/eventos                  events_list_57      14
 *   Ansião          /concelho/comunicacao/eventos                   —                    1
 *   Peniche         /visitar/agenda-de-eventos/todos-os-eventos     events_list_69      24
 *   Pedrógão Grande /viver/cultura/agenda-de-eventos                —                    1
 *
 * Pombal is deliberately EXCLUDED: its agenda page is a document-folder widget
 * (`folders_list_42_folder_id=…`) with no `EventDetail` markup — it needs a
 * PDF/document pipeline, not this parser.
 *
 * Time handling (verified live 2026-09-11): `atc_date_start` values are
 * Europe/Lisbon wall-clock. The `meta[name=content_date]` twin carries the same
 * clock time with a bogus `Z` suffix (a Batalha event at 21:30 local is
 * published as `2026-09-12T21:30:00.000Z`), so the Z is stripped and the value
 * is read as Lisbon local time.
 *
 * Dirty-date guard: some council entries (observed on Pedrógão Grande) never
 * had their time set, so the CMS serialises the *publication* timestamp as the
 * event start. When `atc_date_start` matches `published_at` /
 * `last_modified_date` to the minute the clock time is dropped (all-day event
 * pinned to 00:00) instead of minting an event at publish o'clock.
 *
 * Scope: every site is one concelho, so `city` is the council name and the
 * district gate is satisfied by construction; `isInScope` still runs so the
 * gate stays the single source of truth for district membership.
 *
 * Incremental state (`state/municipal.json`): `{ seen[] }` of fetched detail
 * URLs (one file, URLs carry the host). Listing pages are always walked from
 * page 1 to the site's last page — the CMS listing order is not date-sorted,
 * so a short walk cannot be trusted to surface new items. Item chips that
 * unambiguously date an item in the past are skipped without a detail fetch and
 * deliberately NOT marked seen, so an item whose date is later corrected to the
 * future is picked up on the next run.
 */

export interface MunicipalSite {
	/** stable key used in fixtures/tests */
	key: string;
	/** source-id prefix for slugs (`mg-festa-arraial-…`) */
	prefix: string;
	/** concelho, as displayed */
	city: string;
	origin: string;
	/** absolute listing URL */
	listing: string;
	/** wm-smile paginator id, e.g. `events_list_13` */
	paginator: string | null;
	/** last listing page observed live (2026-09-11) */
	maxPages: number;
}

export const SITES: MunicipalSite[] = [
	{
		key: "marinha-grande",
		prefix: "mg",
		city: "Marinha Grande",
		origin: "https://www.cm-mgrande.pt",
		listing: "https://www.cm-mgrande.pt/comunicar/eventos/todos-os-eventos",
		paginator: "events_list_13",
		maxPages: 44,
	},
	{
		key: "nazare",
		prefix: "nz",
		city: "Nazaré",
		origin: "https://www.cm-nazare.pt",
		listing: "https://www.cm-nazare.pt/visitar/todos-os-eventos",
		paginator: "events_list_73",
		maxPages: 71,
	},
	{
		key: "batalha",
		prefix: "bt",
		city: "Batalha",
		origin: "https://www.cm-batalha.pt",
		listing: "https://www.cm-batalha.pt/municipe/comunicacao/agenda-cultural",
		paginator: null,
		maxPages: 1,
	},
	{
		key: "alvaiazere",
		prefix: "av",
		city: "Alvaiázere",
		origin: "https://www.cm-alvaiazere.pt",
		listing: "https://www.cm-alvaiazere.pt/municipio/comunicacao/eventos",
		paginator: "events_list_57",
		maxPages: 14,
	},
	{
		key: "ansiao",
		prefix: "an",
		city: "Ansião",
		origin: "https://www.cm-ansiao.pt",
		listing: "https://www.cm-ansiao.pt/concelho/comunicacao/eventos",
		paginator: null,
		maxPages: 1,
	},
	{
		key: "peniche",
		prefix: "pn",
		city: "Peniche",
		origin: "https://www.cm-peniche.pt",
		listing:
			"https://www.cm-peniche.pt/visitar/agenda-de-eventos/todos-os-eventos",
		paginator: "events_list_69",
		maxPages: 24,
	},
	{
		key: "pedrogao-grande",
		prefix: "pg",
		city: "Pedrógão Grande",
		origin: "https://www.cm-pedrogaogrande.pt",
		listing: "https://www.cm-pedrogaogrande.pt/viver/cultura/agenda-de-eventos",
		paginator: null,
		maxPages: 1,
	},
];

/** Safety net on detail fetches per run; unseen urls are retried next run. */
export const MAX_DETAIL_REQUESTS = 800;
/** A source date counts as live until one day past its end. */
export const PAST_TOLERANCE_S = 86_400;

export interface MunicipalState {
	seen: string[];
}

export const DEFAULT_STATE: MunicipalState = { seen: [] };

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Unique detail urls discovered across all listing pages. */
	discovered: number;
	/** Saves the new seen urls; the runner calls it after ingest (C7). */
	commit: () => void;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	loadState: () => MunicipalState;
	saveState: (s: MunicipalState) => void;
	now: number;
}

// Entity decoding lives in ./normalize: one canonical table for every
// SLICE_9 source. The private copy that lived here had drifted (it knew
// `&ecirc;`/`&auml;`, the shared one knew `&lsquo;`), so identical CMS markup
// decoded differently depending on which scraper read it.

function monthNumber(token: string): number | null {
	const trimmed = decodeEntities(token).trim();
	if (/^\d{1,2}$/.test(trimmed)) {
		const n = Number(trimmed);
		if (n >= 1 && n <= 12) {
			return n;
		}
	}
	return monthFromPrefix(trimmed);
}

/** `26` -> 2026, `2026` -> 2026. */
function fullYear(raw: string): number {
	const n = Number(raw);
	return raw.length <= 2 ? (n >= 70 ? 1900 + n : 2000 + n) : n;
}

/** Days in a month, leap-year aware. */
function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
	}
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

/**
 * Lisbon epoch for a wall-clock date, or null when that date cannot exist.
 * `toEpochInLisbon` throws on an impossible calendar date, and a source chip is
 * allowed to be wrong — a Marinha Grande page carries "29.02.23" and Feb 2023
 * has 28 days. A bogus chip must degrade to "undated", never kill the source.
 */
function epochOrNull(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
): number | null {
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day) ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59
	) {
		return null;
	}
	return toEpochInLisbonOrNull(year, month, day, hour, minute);
}

/** Epoch (Lisbon wall clock) from a source `YYYY-MM-DD[ T]HH:mm[:ss]` string. */
export function parseWallClock(raw: string | null | undefined): number | null {
	if (!raw) {
		return null;
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw.trim());
	if (!m) {
		return null;
	}
	const [, y, mo, d, h, mi] = m;
	if (!y || !mo || !d || !h || !mi) {
		return null;
	}
	return epochOrNull(+y, +mo, +d, +h, +mi);
}

/** `YYYY-MM-DD HH:mm` key used to spot a CMS default (publication) time. */
function minuteKey(raw: string | null | undefined): string | null {
	if (!raw) {
		return null;
	}
	const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(raw.trim());
	return m ? `${m[1]} ${m[2]}` : null;
}

export function isDefaultEventTime(
	startRaw: string | null | undefined,
	publishedAt: string | null | undefined,
	lastModified: string | null | undefined,
): boolean {
	const start = minuteKey(startRaw);
	if (!start) {
		return false;
	}
	return start === minuteKey(publishedAt) || start === minuteKey(lastModified);
}

export interface ListingItem {
	url: string;
	/** earliest date the listing chip mentions, when it can be dated at all */
	earliest: number | null;
	/** latest date the listing chip mentions, when it can be dated at all */
	latest: number | null;
}

/**
 * Every `/evento/<slug>` link on a listing page, paired with the date range its
 * own item chip shows. Chips come in five shapes (verified live):
 *   `2026/10/04`                          ISO (Marinha Grande, Alvaiázere)
 *   `17.10.26 a 22.11.26`                 dotted `d.m.yy` (Nazaré)
 *   `05 Setembro a 05 Dezembro 2026`      day + month name + year (Peniche, Batalha)
 *   `11 Set` / `03 a 30 Set`              day + month, NO year (Ansião, Pedrógão Grande)
 * Items whose chip carries no year cannot be dated here — `latest` stays null
 * and the caller falls back to fetching the detail page.
 */
export function parseListingItems(
	html: string,
	site: Pick<MunicipalSite, "origin">,
): ListingItem[] {
	const links = [...html.matchAll(/href="([^"]*\/evento\/[^"/#?]+)"/g)];
	const items: ListingItem[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < links.length; i++) {
		const match = links[i];
		if (!match) {
			continue;
		}
		let url: string;
		try {
			url = new URL(decodeEntities(match[1] ?? ""), site.origin).toString();
		} catch {
			continue;
		}
		if (seen.has(url)) {
			continue;
		}
		seen.add(url);
		const next = links[i + 1];
		const chunk = html.slice(
			match.index ?? 0,
			next?.index ?? (match.index ?? 0) + 3000,
		);
		const { earliest, latest } = parseListingDates(chunk);
		items.push({ url, earliest, latest });
	}
	return items;
}

/** Date range of one listing item chip, when the chip carries a year. */
export function parseListingDates(chunk: string): {
	earliest: number | null;
	latest: number | null;
} {
	const dates: number[] = [];

	// ISO: 2026/10/04
	for (const m of chunk.matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2})/g)) {
		const epoch = epochOrNull(
			Number(m[1] ?? Number.NaN),
			Number(m[2] ?? Number.NaN),
			Number(m[3] ?? Number.NaN),
		);
		if (epoch != null) {
			dates.push(epoch);
		}
	}
	// Dotted: 17.10.26
	for (const m of chunk.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?!\d)/g)) {
		const epoch = epochOrNull(
			fullYear(`${m[3] ?? ""}`),
			Number(m[2] ?? Number.NaN),
			Number(m[1] ?? Number.NaN),
		);
		if (epoch != null) {
			dates.push(epoch);
		}
	}
	if (dates.length > 0) {
		return { earliest: Math.min(...dates), latest: Math.max(...dates) };
	}

	// Day + month + year, spread over the chip's spans.
	const days = [...chunk.matchAll(/class="?dia"?>\s*(\d{1,2})/g)]
		.map((m) => Number(m[1] ?? Number.NaN))
		.filter((n) => Number.isFinite(n));
	const months = [
		...chunk.matchAll(
			/class="?mes(?:_curto|_extenso)?"?>\s*([A-Za-zÀ-ÿ]+|\d{1,2})/g,
		),
	]
		.map((m) => monthNumber(`${m[1] ?? ""}`))
		.filter((v): v is number => v != null);
	const yearMatch = /class="?ano"?>\s*(\d{2,4})/.exec(chunk);
	const firstDay = days.at(0);
	const lastDay = days.at(-1);
	const firstMonth = months.at(0);
	const lastMonth = months.at(-1);
	if (
		firstDay == null ||
		lastDay == null ||
		firstMonth == null ||
		lastMonth == null ||
		!yearMatch?.[1]
	) {
		return { earliest: null, latest: null };
	}
	const year = fullYear(yearMatch[1]);
	const candidates = [
		epochOrNull(year, firstMonth, firstDay),
		epochOrNull(year, lastMonth, lastDay),
	].filter((v): v is number => v != null);
	if (candidates.length === 0) {
		return { earliest: null, latest: null };
	}
	return { earliest: Math.min(...candidates), latest: Math.max(...candidates) };
}

export interface MunicipalDetail {
	title: string | null;
	atcStart: string | null;
	atcEnd: string | null;
	atcLocation: string | null;
	/** `Local:` widget value */
	local: string | null;
	categories: string[];
	description: string | null;
	imageUrl: string | null;
	contentDate: string | null;
	publishedAt: string | null;
	lastModified: string | null;
	/** dates shown by the detail `dates` chip (fallback when there is no atc block) */
	chipEarliest: number | null;
	chipLatest: number | null;
}

/** Text of `class="<name> widget_field"`'s `writer_text` block, if present. */
function widgetText(html: string, name: string): string | null {
	const marker = new RegExp(`class="${name} widget_field\\s*"[^>]*>`);
	const found = marker.exec(html);
	if (!found) {
		return null;
	}
	const rest = html.slice(found.index);
	const writerAt = rest.search(/class="writer_text"[^>]*>/);
	if (writerAt < 0 || writerAt > 1500) {
		return null;
	}
	const body = rest.slice(writerAt);
	const close = body.search(/<div class="writer_text_clear"/);
	const inner = close > 0 ? body.slice(0, close) : body.slice(0, 1200);
	const value = textOf(inner.slice(inner.indexOf(">") + 1));
	return value.length > 0 ? value : null;
}

/** `<span>` values inside `class="<name> widget_field"` (category chips). */
function widgetSpans(html: string, name: string): string[] {
	const marker = new RegExp(`class="${name} widget_field\\s*"[^>]*>`);
	const found = marker.exec(html);
	if (!found) {
		return [];
	}
	const rest = html.slice(found.index + found[0].length);
	const cut = rest.search(
		/<div class="(?:[a-z_]+ widget_field|addtocalendar|google_map)/,
	);
	const window = cut > 0 ? rest.slice(0, cut) : rest.slice(0, 800);
	return [...window.matchAll(/<span[^>]*>([^<]+)<\/span>/g)]
		.map((m) =>
			decodeEntities(m[1] ?? "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter((v) => v.length > 0);
}

export function parseDetail(html: string): MunicipalDetail {
	const meta = (name: string): string | null => {
		const byName = new RegExp(
			`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`,
		).exec(html);
		if (byName) {
			return decodeEntities(byName[1] ?? "").trim() || null;
		}
		const byProperty = new RegExp(
			`<meta[^>]+property="${name}"[^>]+content="([^"]*)"`,
		).exec(html);
		return byProperty
			? decodeEntities(byProperty[1] ?? "").trim() || null
			: null;
	};
	const varOf = (name: string): string | null => {
		const m = new RegExp(`class="atc_${name}"[^>]*>([^<]*)<`).exec(html);
		return m ? decodeEntities(m[1] ?? "").trim() || null : null;
	};

	const h1 = textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "");
	const chip =
		/class="dates widget_field\s*"[^>]*>([\s\S]{0,400}?)(?=<div class="(?:[a-z_]+ widget_field|addtocalendar|google_map))/;
	const chipMatch = chip.exec(html);
	const chipDates = chipMatch
		? parseListingDates(chipMatch[1] ?? "")
		: { earliest: null, latest: null };

	return {
		title: varOf("title") ?? (h1.length > 0 ? h1 : null) ?? meta("og:title"),
		atcStart: varOf("date_start"),
		atcEnd: varOf("date_end"),
		atcLocation: varOf("location"),
		local: widgetText(html, "location"),
		categories: widgetSpans(html, "categories"),
		description: widgetText(html, "summary") ?? meta("description"),
		imageUrl: meta("og:image"),
		contentDate: meta("content_date"),
		publishedAt: meta("published_at"),
		lastModified: meta("last_modified_date"),
		chipEarliest: chipDates.earliest,
		chipLatest: chipDates.latest,
	};
}

/** Values some councils leave in the venue slot when no venue was typed. */
const VENUE_PLACEHOLDERS =
	/^(evento|eventos|local|local a definir|a definir|sem local|n\/a|-+)$/i;

export function pickVenue(
	local: string | null,
	atcLocation: string | null,
	city: string,
): string {
	for (const candidate of [local, atcLocation]) {
		const value = candidate?.replace(/\s+/g, " ").trim();
		if (value && !VENUE_PLACEHOLDERS.test(value)) {
			return value;
		}
	}
	return city;
}

/** Stable source id from the detail slug, prefixed per council. */
export function slugFor(site: MunicipalSite, url: string): string {
	const tail = decodeURIComponent(url.split("/evento/")[1] ?? "").replace(
		/[/?#].*$/,
		"",
	);
	return `${site.prefix}-${tail}`;
}

export function toRawEvent(
	site: MunicipalSite,
	url: string,
	detail: MunicipalDetail,
	now: number,
): RawEvent | null {
	const title = detail.title?.replace(/\s+/g, " ").trim();
	if (!title) {
		return null;
	}

	let startAt = parseWallClock(detail.atcStart);
	if (
		startAt != null &&
		isDefaultEventTime(detail.atcStart, detail.publishedAt, detail.lastModified)
	) {
		// CMS left its default (publication) time → all-day event.
		startAt = parseWallClock(`${detail.atcStart?.slice(0, 10)} 00:00`);
	}
	if (startAt == null) {
		startAt = parseWallClock(detail.contentDate);
	}
	if (startAt == null) {
		startAt = detail.chipEarliest ?? detail.chipLatest;
	}
	if (startAt == null) {
		// No machine-readable date anywhere → drop rather than mint a
		// placeholder-dated event at ingestion time.
		return null;
	}

	let endAt = parseWallClock(detail.atcEnd);
	if (
		endAt == null &&
		detail.chipLatest != null &&
		detail.chipLatest > startAt
	) {
		// chip ranges are day-granular: keep the end at 00:00 of its day.
		endAt = detail.chipLatest;
	}
	if (endAt != null && endAt <= startAt) {
		endAt = null;
	}

	const reference = endAt ?? startAt;
	if (reference + PAST_TOLERANCE_S < now) {
		return null; // already over
	}

	return {
		title,
		slug: slugFor(site, url),
		description: detail.description,
		startAt,
		endAt,
		dateText: null,
		venueName: pickVenue(detail.local, detail.atcLocation, site.city),
		city: site.city,
		categories: detail.categories,
		imageUrl: detail.imageUrl,
		url,
	};
}

export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		loadState: () => loadState("municipal", DEFAULT_STATE),
		saveState: (s) => saveState("municipal", s),
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (city: string | null | undefined) => boolean = isLeiriaDistrict,
): Promise<ScrapeResult> {
	let pagesFetched = 0;
	let failures = 0;
	let firstError: string | null = null;
	let detailRequests = 0;

	const state = deps.loadState();
	const seen = new Set(state.seen);
	/** Fetched this run (never fetched twice in one walk). */
	const fetched = new Set<string>();
	/** Fetched and emitted or deliberately skipped: marked seen on commit. */
	const handled = new Set<string>();
	const discovered = new Set<string>();
	const events: RawEvent[] = [];
	const delay = () => deps.sleep(randomDelay());

	for (const site of SITES) {
		// Consecutive pages where every attempt failed: one dead page is
		// skipped, two in a row mean the council's site is down and hammering
		// the rest of its pages helps nobody.
		let deadPages = 0;
		for (let page = 1; page <= site.maxPages; page++) {
			const url =
				page === 1 || !site.paginator
					? site.listing
					: `${site.listing}?${site.paginator}_page=${page}&paginating=true`;
			// One attempt: http.ts owns retries (and the 4xx/Retry-After policy),
			// so wrapping it here would stack up to 9 requests per page.
			let html: string | null = null;
			let lastError: string | null = null;
			try {
				await delay();
				html = await deps.fetchText(url);
				pagesFetched++;
			} catch (err) {
				lastError = errorMessage(err);
			}
			if (html === null) {
				// Paginator pages are addressed explicitly (`_page=N`), so a
				// failing page is skipped instead of ending the walk: `break`
				// here is what kept Marinha Grande pages 32-44 unfetched on
				// EVERY run after the 403 at page 31.
				failures++;
				firstError ??= `${url}: ${lastError ?? "unknown error"}`;
				deadPages++;
				if (deadPages >= 2) {
					break; // council unreachable — the next council still runs
				}
				continue;
			}
			deadPages = 0;
			const items = parseListingItems(html, site);
			if (page === 1 && items.length === 0) {
				// A council's first listing page always lists events: zero items
				// means broken markup or a challenge page, not a quiet day.
				failures++;
				firstError ??= `${url}: listing parsed to zero items`;
			}
			for (const item of items) {
				discovered.add(item.url);
				// Already ingested in a previous run, or already handled on an
				// earlier page of THIS run (a paginator can repeat an item when
				// the roster shifts mid-walk) — either way, never emit it twice.
				if (seen.has(item.url) || fetched.has(item.url)) {
					continue;
				}
				if (item.latest != null && item.latest + PAST_TOLERANCE_S < deps.now) {
					continue; // listing already dates it in the past
				}
				if (detailRequests >= MAX_DETAIL_REQUESTS) {
					continue; // retried on the next run, not marked seen
				}
				try {
					await delay();
					const detailHtml = await deps.fetchText(item.url);
					detailRequests++;
					pagesFetched++;
					fetched.add(item.url);
					const detail = parseDetail(detailHtml);
					const raw = toRawEvent(site, item.url, detail, deps.now);
					if (raw) {
						// Emitted, or deliberately out of district: done with it.
						handled.add(item.url);
						if (isInScope(raw.city)) {
							events.push(raw);
						}
					} else if (
						// Parses fine and is merely over: a deliberate skip too.
						// No title or no date is a parse failure: retried next run.
						toRawEvent(site, item.url, detail, Number.NEGATIVE_INFINITY)
					) {
						handled.add(item.url);
					}
				} catch (err) {
					failures++;
					firstError ??= err instanceof Error ? err.message : String(err);
				}
			}
		}
	}

	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered: discovered.size,
		// Deferred (C7): the runner saves only after ingest committed. Only
		// handled items are marked; a failed fetch or parse is retried.
		commit: () =>
			deps.saveState({ seen: [...new Set([...state.seen, ...handled])] }),
	};
}
