import { errorMessage } from "./errors";
import { toEpochInLisbonOrNull } from "./fingerprint";
import { defaultFetchText } from "./http";
import { foldAccents, monthFromName } from "./lib/pt-dates";
import { defaultSleep } from "./lib/timing";
import { plainText } from "./normalize";
import type { RawEvent } from "./types";

/**
 * figueiro — coverage for the Município de Figueiró dos Vinhos agenda
 * (cm-figueirodosvinhos.pt), a Joomla site running `com_djevents`.
 *
 * RECON (2026-09-12): the task note called the `listar-agenda-rss` view an RSS
 * feed — it is not. `?format=feed` answers HTTP 500 on every variant tried;
 * what the view actually serves is a *server-rendered listing* of the whole
 * municipal agenda (6 items on the first run), which is better than a feed:
 * one request, no pagination, no JS. So:
 *
 *   Listing: GET /index.php/listar-agenda-rss
 *   → `div.djev_item` blocks. Each carries the title + permanent link
 *     (`.djev_item_title a`), the PT long-form date pair (`.djev_time_from`
 *     / `.djev_time_to`, e.g. "Sábado, 19 setembro 2026 at 18:30"), an
 *     optional intro (`.djev_intro`), the municipality (`.djev_city`), the
 *     section (`.djev_category`) and a relative image path (`.djev_image`).
 *     The link path repeats the start date as ISO
 *     (`/details/2026-09-19/224-figueiro-colorido-caminhada-solidaria`), used
 *     as the fallback when the long-form date fails to parse.
 *
 * Dates are rebuilt into Europe/Lisbon wall-clock via toEpochInLisbon, never
 * read as UTC. A `to` date with no clock time is treated as the END OF THAT
 * DAY (the agenda publishes spans, e.g. "1 janeiro 2025 → 31 dezembro 2026");
 * an item with no `to` at all keeps a null end when it carries a clock time,
 * and closes at end of day when it is day-precision. Events whose end is past
 * are dropped, never rolled forward (RETRO_TOLERANCE_S below).
 *
 * Scope: the agenda is the municipality's own, so `.djev_city` is the
 * concelho (Figueiró dos Vinhos ⇒ Distrito de Leiria) and the gate drops
 * nothing in practice — the injectable hook is kept so the district rule
 * lives in one place, and a mis-filed row is reported, not guessed at.
 *
 * No state file: the listing is small and completely re-emitted each run; the
 * fingerprint pipeline is what makes re-ingestion a no-op. No detail fetch
 * either — the venue is not in the listing and the detail page carries no
 * machine-readable venue, so the honest fallback is the concelho-level
 * DEFAULT_VENUE (same rule as the caldas source).
 */

export const SITE = "https://www.cm-figueirodosvinhos.pt";
export const AGENDA_PATH = "/index.php/listar-agenda-rss";
/**
 * Gates the "past" drop. NOT a no-op: a timed item with no `to` keeps a null
 * end, so `effectivelyOver` is its START instant, while ingest keeps such a
 * row until the end of its Lisbon day. One day of slack stops this gate from
 * dropping an event that is still on tonight.
 */
export const RETRO_TOLERANCE_S = 86_400;
/** The agenda names no venue: the concelho is the honest, vague fallback. */
export const DEFAULT_VENUE = "Figueiró dos Vinhos";
/** The section name every listing row carries — not a category worth keeping. */
const SECTION_LABEL = "agenda";

export interface DateParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	/** True when the source actually published a clock time. */
	hasTime: boolean;
}

export interface DjevItem {
	slug: string;
	href: string;
	title: string;
	from: DateParts | null;
	to: DateParts | null;
	description: string | null;
	city: string | null;
	category: string | null;
	imageUrl: string | null;
}

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Listing rows seen this run, before any gate. */
	discovered: number;
	/** Rows dropped because the resolved city is outside the district. */
	droppedOutOfDistrict: number;
	/** Rows dropped because the event is already over. */
	droppedPast: number;
	/** Rows dropped because no date could be read at all. */
	droppedUndated: number;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	now: number;
}

/**
 * Parse a com_djevents long-form date: "Sábado, 19 setembro 2026 at 18:30",
 * "quinta, 31 dezembro 2026", "1 janeiro 2025 às 10h00". Returns null when the
 * string carries no usable date, so the caller can fall back to the URL's ISO
 * path segment — never to a guessed date.
 */
export function parseDjevDate(raw: string): DateParts | null {
	const text = plainText(raw);
	const m =
		/(\d{1,2})\s*(?:de\s+)?([A-Za-zÀ-ÿ]+)\.?\s*(?:de\s+)?(\d{4})(?:\D{0,6}(\d{1,2})[:h](\d{2}))?/.exec(
			text,
		);
	if (!m) {
		return null;
	}
	const monthName = m[2] ?? "";
	const month = monthFromName(monthName);
	if (!month) {
		return null;
	}
	const day = Number(m[1]);
	const year = Number(m[3]);
	const hasTime = m[4] !== undefined;
	const hour = hasTime ? Number(m[4]) : 0;
	const minute = hasTime ? Number(m[5]) : 0;
	if (day < 1 || day > 31 || hour > 23 || minute > 59) {
		return null;
	}
	return { year, month, day, hour, minute, hasTime };
}

const firstGroup = (text: string, re: RegExp): string | null =>
	re.exec(text)?.[1] ?? null;

/** ISO `YYYY-MM-DD` embedded in a details link, as a day-precision fallback. */
export function dateFromHref(href: string): DateParts | null {
	const m = /\/details\/(\d{4})-(\d{2})-(\d{2})\//.exec(href);
	if (!m) {
		return null;
	}
	return {
		year: Number(m[1]),
		month: Number(m[2]),
		day: Number(m[3]),
		hour: 0,
		minute: 0,
		hasTime: false,
	};
}

const slugFromHref = (href: string): string =>
	href
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.split("/")
		.pop() ?? href;

const absolute = (url: string): string =>
	/^https?:\/\//.test(url)
		? url
		: `${SITE}${url.startsWith("/") ? "" : "/"}${url}`;

/**
 * Parse the listing HTML into items. Splitting on the item wrapper (not on a
 * full DOM walk) is deliberate: the markup is flat and stable, and a regex
 * split cannot silently re-nest a malformed row.
 */
export function parseItems(html: string): DjevItem[] {
	const chunks = html.split(/<div[^>]*class="[^"]*\bdjev_item\b/).slice(1);
	const items: DjevItem[] = [];
	for (const chunk of chunks) {
		const href = firstGroup(
			chunk,
			/<h2[^>]*class="[^"]*djev_item_title[^"]*"[\s\S]{0,200}?<a[^>]*href="([^"]+)"/i,
		);
		const titleHtml = firstGroup(
			chunk,
			/<h2[^>]*class="[^"]*djev_item_title[^"]*"[\s\S]{0,200}?<a[^>]*>([\s\S]*?)<\/a>/i,
		);
		const title = titleHtml ? plainText(titleHtml) : "";
		if (!href || !title) {
			continue;
		}

		// The time block holds both dates: everything before `djev_time_to`
		// belongs to the start, everything from it on to the end.
		const timeBlock =
			firstGroup(
				chunk,
				/<h4[^>]*class="[^"]*djev_time[^"]*"[^>]*>([\s\S]*?)<\/h4>/i,
			) ?? "";
		const toIndex = timeBlock.search(/djev_time_to/i);
		const fromRaw = toIndex >= 0 ? timeBlock.slice(0, toIndex) : timeBlock;
		const toRaw = toIndex >= 0 ? timeBlock.slice(toIndex) : "";

		const city = firstGroup(
			chunk,
			/<a[^>]*class="[^"]*djev_city[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
		);
		const category = firstGroup(
			chunk,
			/<a[^>]*class="[^"]*djev_category[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
		);
		const intro = firstGroup(
			chunk,
			/<div[^>]*class="[^"]*djev_intro[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
		);
		const imgSrc =
			firstGroup(
				chunk,
				/<img[^>]*class="[^"]*djev_image[^"]*"[^>]*src="([^"]+)"/i,
			) ??
			firstGroup(
				chunk,
				/<img[^>]*src="([^"]+)"[^>]*class="[^"]*djev_image[^"]*"/i,
			);

		items.push({
			slug: slugFromHref(href),
			href,
			title,
			from: parseDjevDate(fromRaw),
			to: toRaw.trim().length > 0 ? parseDjevDate(toRaw) : null,
			description: intro && plainText(intro) ? plainText(intro) : null,
			city: city ? plainText(city) : null,
			category: category ? plainText(category) : null,
			imageUrl: imgSrc ? absolute(imgSrc) : null,
		});
	}
	return items;
}

/** `invalidDate` = the chip names a day that cannot exist (30 Feb): counted
 * as a source failure, not a quiet drop. */
export type DropReason = "outOfDistrict" | "past" | "undated" | "invalidDate";

export interface Conversion {
	raw: RawEvent | null;
	reason: DropReason | null;
}

/** Turn one listing row into a RawEvent, or report why it cannot be one. */
export function toRawEvent(
	item: DjevItem,
	isInScope: (city: string | null | undefined) => boolean,
	now: number,
): Conversion {
	const start = item.from ?? dateFromHref(item.href);
	if (!start) {
		return { raw: null, reason: "undated" };
	}
	const startAt = toEpochInLisbonOrNull(
		start.year,
		start.month,
		start.day,
		start.hour,
		start.minute,
	);
	const endOfStartDay = toEpochInLisbonOrNull(
		start.year,
		start.month,
		start.day,
		23,
		59,
	);
	if (startAt == null || endOfStartDay == null) {
		return { raw: null, reason: "invalidDate" };
	}
	let endAt: number | null;
	if (item.to) {
		endAt = item.to.hasTime
			? toEpochInLisbonOrNull(
					item.to.year,
					item.to.month,
					item.to.day,
					item.to.hour,
					item.to.minute,
				)
			: toEpochInLisbonOrNull(item.to.year, item.to.month, item.to.day, 23, 59);
		if (endAt == null) {
			return { raw: null, reason: "invalidDate" };
		}
	} else {
		endAt = start.hasTime ? null : endOfStartDay;
	}

	const effectivelyOver = endAt ?? startAt;
	if (effectivelyOver < now - RETRO_TOLERANCE_S) {
		return { raw: null, reason: "past" };
	}

	const city = item.city?.trim() || DEFAULT_VENUE;
	if (!isInScope(city)) {
		return { raw: null, reason: "outOfDistrict" };
	}

	const category = item.category?.trim() ?? "";
	return {
		raw: {
			title: item.title,
			slug: item.slug,
			description: item.description,
			startAt,
			endAt,
			dateText: null,
			venueName: city,
			city,
			categories:
				category &&
				foldAccents(category).replace(/[.\s]+$/, "") !== SECTION_LABEL
					? [category]
					: [],
			imageUrl: item.imageUrl,
			url: absolute(item.href),
		},
		reason: null,
	};
}

/**
 * Scrape the municipal agenda. One listing request; `isInScope` is the
 * district gate (injectable so tests can pin the rule).
 */
export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (city: string | null | undefined) => boolean = () => true,
): Promise<ScrapeResult> {
	const url = `${SITE}${AGENDA_PATH}`;
	let pagesFetched = 0;
	let failures = 0;
	let firstError: string | null = null;
	let html = "";
	try {
		html = await deps.fetchText(url);
		pagesFetched++;
	} catch (err) {
		failures++;
		firstError = `${url}: ${errorMessage(err)}`;
	}

	const items = html ? parseItems(html) : [];
	if (html && items.length === 0) {
		// The agenda page is fetched but parses to zero items: broken markup or a
		// challenge page, not a quiet day (a failed fetch is already counted).
		failures++;
		firstError ??= `${url}: listing parsed to zero items`;
	}
	const events: RawEvent[] = [];
	const seenSlugs = new Set<string>();
	let droppedOutOfDistrict = 0;
	let droppedPast = 0;
	let droppedUndated = 0;

	for (const item of items) {
		const { raw, reason } = toRawEvent(item, isInScope, deps.now);
		if (!raw) {
			if (reason === "outOfDistrict") droppedOutOfDistrict++;
			else if (reason === "past") droppedPast++;
			else if (reason === "invalidDate") {
				failures++;
				firstError ??= `${item.href}: impossible date`;
			} else droppedUndated++;
			continue;
		}
		if (seenSlugs.has(raw.slug)) {
			continue;
		}
		seenSlugs.add(raw.slug);
		events.push(raw);
	}

	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered: items.length,
		droppedOutOfDistrict,
		droppedPast,
		droppedUndated,
	};
}
