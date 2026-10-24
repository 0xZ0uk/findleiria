import { toEpochInLisbonOrNull } from "./fingerprint";
import { defaultFetchText } from "./http";
import type { RawEvent } from "./types";

export const RSS_URL = "https://www.cm-leiria.pt/rss-feed/rss-de-eventos.rss";

/**
 * Pseudo-categories that describe channel placement rather than the event's
 * subject — never surfaced as a real category.
 */
const PSEUDO_CATEGORIES = new Set([
	"Evento",
	"Homepage | Agenda",
	"Newsletter | Evento Destaque",
	"Newsletter | Eventos Listagem",
]);

const PT_MONTHS: Record<string, number> = {
	janeiro: 1,
	fevereiro: 2,
	marco: 3,
	março: 3,
	abril: 4,
	maio: 5,
	junho: 6,
	julho: 7,
	agosto: 8,
	setembro: 9,
	outubro: 10,
	novembro: 11,
	dezembro: 12,
	// Abbreviations (longest-first matching is handled by sort below).
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
// Longest names first so "setembro" wins over "set" in alternation.
const MONTH_ALT = Object.keys(PT_MONTHS)
	.sort((a, b) => b.length - a.length)
	.join("|");

/** Venue strings that mean "not announced yet" — fall back to the default. */
const JUNK_VENUES = new Set(["a confirmar", "a definir", "a anunciar"]);

export interface ParsedDate {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	hasTime: boolean;
}

interface TimeToken {
	hour: number;
	minute: number;
}

/** Strip diacritics + lowercase so accented text matches ASCII month names. */
function foldText(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

/** A time token (HHhMM / HHh) within `limit` chars of `from`? */
function timeAfter(text: string, from: number, limit = 16): TimeToken | null {
	const seg = text.slice(from, from + limit);
	const m = seg.match(/\b(\d{1,2})h(\d{0,2})\b/);
	if (!m) {
		return null;
	}
	return {
		hour: Number.parseInt(m[1] ?? "0", 10),
		minute: Number.parseInt(m[2] ?? "0", 10),
	};
}

/**
 * Resolve the year for a month-only date relative to the item's publication
 * instant. Events happen on/after publication, so pick the smallest year
 * >= pub-year for which (month, day) does not fall before the pub date.
 * Anchoring to pubDate (not "now") keeps stale feeds in their real year
 * instead of projecting old items into the future.
 */
function resolveYear(month: number, day: number, refMs: number): number {
	const ref = new Date(refMs);
	const refYear = ref.getUTCFullYear();
	const refMonth = ref.getUTCMonth() + 1;
	const refDay = ref.getUTCDate();
	const beforeRef = month < refMonth || (month === refMonth && day < refDay);
	return beforeRef ? refYear + 1 : refYear;
}

interface DateMatch extends ParsedDate {
	followsTime: boolean;
	order: number;
}

function pushMatch(
	matches: DateMatch[],
	order: number,
	base: { year: number; month: number; day: number },
	time: TimeToken | null,
): void {
	matches.push({
		year: base.year,
		month: base.month,
		day: base.day,
		hour: time?.hour ?? 0,
		minute: time?.minute ?? 0,
		hasTime: time !== null,
		followsTime: time !== null,
		order,
	});
}

/**
 * Extract an event start date from free text. Real-event dates in this feed
 * sit at the END of the description and are followed by a time (e.g.
 * "25 de janeiro às 18h30"), whereas prose often cites historical/reference
 * dates (e.g. "13 de novembro de 2015"). So: prefer the first date whose
 * following chars hold a time; otherwise fall back to the first structural
 * match.
 */
export function extractDate(
	text: string,
	refMs: number = Date.now(),
): ParsedDate | null {
	const norm = foldText(text);
	const matches: DateMatch[] = [];
	let order = 0;

	// Explicit year first: "12 de março de 2026 [às 21h30]" — the most
	// specific form wins outright, so the infer-year branch never sees it.
	for (const m of norm.matchAll(
		new RegExp(
			`\\b(\\d{1,2})(?:\\s+de)?\\s+(${MONTH_ALT})\\s+de?\\s*(\\d{4})\\b(?:\\s+as?\\s*(\\d{1,2})h(\\d{2})?)?`,
			"g",
		),
	)) {
		const month = PT_MONTHS[m[2] ?? ""];
		if (month == null) {
			continue;
		}
		const hh = m[4] != null ? Number.parseInt(m[4], 10) : null;
		const mm = m[5] != null ? Number.parseInt(m[5], 10) : null;
		pushMatch(
			matches,
			order++,
			{
				year: Number.parseInt(m[3] ?? "0", 10),
				month,
				day: Number.parseInt(m[1] ?? "0", 10),
			},
			hh != null && mm != null ? { hour: hh, minute: mm } : null,
		);
	}

	const dayMonthRe = new RegExp(
		`(\\d{1,2}(?:\\s*[,e]+\\s*\\d{1,2})*)\\s*(?:de\\s+)?(${MONTH_ALT})(?![\\p{L}\\u00C0-\\u024F])(?!\\s*(?:de\\s*)?\\d{4})`,
		"g",
	);
	for (const m of norm.matchAll(dayMonthRe)) {
		const dayText = m[1] ?? "";
		const dayNum = dayText.match(/\d{1,2}/)?.[0];
		if (dayNum == null) {
			continue;
		}
		const month = PT_MONTHS[m[2] ?? ""];
		if (month == null) {
			continue;
		}
		const day = Number.parseInt(dayNum, 10);
		const time = timeAfter(norm, (m.index ?? 0) + (m[0]?.length ?? 0));
		pushMatch(
			matches,
			order++,
			{
				year: resolveYear(month, day, refMs),
				month,
				day,
			},
			time,
		);
	}

	for (const m of norm.matchAll(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g)) {
		pushMatch(
			matches,
			order++,
			{
				year: Number.parseInt(m[3] ?? "0", 10),
				month: Number.parseInt(m[2] ?? "0", 10),
				day: Number.parseInt(m[1] ?? "0", 10),
			},
			// A trailing time ("12/03/2026 às 20h00") belongs to the date.
			timeAfter(norm, (m.index ?? 0) + (m[0]?.length ?? 0)),
		);
	}

	// Explicit-year short form (and the reviewer's explicit-year test case);
	// also reads a trailing time token when present.
	for (const m of norm.matchAll(
		new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})\\s+(\\d{4})\\b`, "g"),
	)) {
		const month = PT_MONTHS[m[2] ?? ""];
		if (month == null) {
			continue;
		}
		pushMatch(
			matches,
			order++,
			{
				year: Number.parseInt(m[3] ?? "0", 10),
				month,
				day: Number.parseInt(m[1] ?? "0", 10),
			},
			timeAfter(norm, (m.index ?? 0) + (m[0]?.length ?? 0)),
		);
	}

	if (matches.length === 0) {
		return null;
	}
	// Preference order: (1) a date with a trailing time, (2) an explicit
	// full-year date (unambiguous), (3) first structural match.
	const timed = matches.find((c) => c.hasTime);
	const explicitYear = matches.find((c) =>
		/\d{4}/.test(String(c.year)) === false
			? false
			: c.year >= 2020 && c.year <= 2100,
	);
	const chosen =
		timed ??
		explicitYear ??
		matches.reduce((a, b) => (a.order <= b.order ? a : b));
	return {
		year: chosen.year,
		month: chosen.month,
		day: chosen.day,
		hour: chosen.hour,
		minute: chosen.minute,
		hasTime: chosen.hasTime,
	};
}

/** The sentence fragment mentioning a date, when no full date patterns hit. */
export function extractDateText(text: string): string | null {
	const m = text.match(new RegExp(`[^.!?]*\\b(?:${MONTH_ALT})\\b[^.!?]*`, "i"));
	if (!m || m[0] == null) {
		return null;
	}
	const fragment = m[0].replace(/^[\s,;:—-]+/, "").trim();
	if (!fragment) {
		return null;
	}
	return fragment.slice(0, 120);
}

/** Extract the venue from a 📌/📍/Local: hint, else the default. */
export function extractVenue(text: string): string {
	const mark = text.match(/[📌📍]\s*([^📌📍\n]+)/u);
	if (mark && mark[1] != null) {
		let venue = mark[1]?.trim() ?? "";
		venue =
			venue
				.split(
					/\s+(?=Mais inform|Página|Bilhetes|Inscri|Crianças|Entrada|Participação|Duração|a partir das|Nos dias|das \d+)/i,
				)[0]
				?.trim() ?? "";
		venue = venue
			.replace(/[\s.\u2026]*$/u, "")
			.replace(/^[\s.\u2026]*/u, "")
			.trim();
		const fold = venue
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.trim();
		if (venue && !JUNK_VENUES.has(fold)) {
			return venue;
		}
	}
	// Separator is REQUIRED so prose like "local a confirmar" (no colon)
	// doesn't match; junk values are filtered there as well.
	const local = text.match(/Local\s*[:\-—]\s*([^.,\n]+)/i);
	if (local && local[1] != null) {
		const venue = local[1].trim();
		const foldLocal = venue
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.trim();
		if (venue && !JUNK_VENUES.has(foldLocal)) {
			return venue;
		}
	}
	return "CM Leiria";
}

interface ParsedItem {
	title: string;
	link: string;
	/** Publication instant (ms) or null when unparsable. */
	pubDateMs: number | null;
	categories: string[];
	descriptionHtml: string;
}

/** Split an RSS 2.0 document into raw <item> blocks (regex, tolerant of embedded HTML). */
export function parseItems(xml: string): ParsedItem[] {
	const out: ParsedItem[] = [];
	for (const block of xml.split("<item>").slice(1)) {
		const raw = block.split("</item>")[0] ?? "";
		const title = raw.match(/<title>(.*?)<\/title>/s)?.[1] ?? "";
		const link = (raw.match(/<link>(.*?)<\/link>/s)?.[1] ?? "").trim();
		if (!link || !title.trim()) {
			continue;
		}
		const categories = [...raw.matchAll(/<category>(.*?)<\/category>/gs)]
			.map((m) => decodeEntities(m[1] ?? ""))
			.filter((c) => c.length > 0);
		const descRaw = raw.match(/<description>(.*?)<\/description>/s)?.[1] ?? "";
		const pubDateRaw = raw.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1] ?? "";
		const pubDateMs = pubDateRaw ? Date.parse(pubDateRaw) : Number.NaN;
		out.push({
			title: decodeEntities(title),
			link,
			pubDateMs: Number.isNaN(pubDateMs) ? null : pubDateMs,
			categories,
			descriptionHtml: decodeEntities(descRaw),
		});
	}
	return out;
}

/**
 * Decode HTML entities WITHOUT cheerio's serializer round-trip, which mangles
 * astral-plane characters (emoji like 📌 arrive as lone surrogate halves).
 * The feed XML-escapes an inner HTML document, so entities are decoded twice;
 * numeric (dec/hex) forms included.
 */
const NAMED_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
	"&aacute;": "á",
	"&eacute;": "é",
	"&iacute;": "í",
	"&oacute;": "ó",
	"&uacute;": "ú",
	"&atilde;": "ã",
	"&otilde;": "õ",
	"&ccedil;": "ç",
	"&acirc;": "â",
	"&ecirc;": "ê",
	"&ocirc;": "ô",
	"&agrave;": "à",
	"&laquo;": "«",
	"&raquo;": "»",
	"\u201C": '"',
	"\u201D": '"',
	"\u2018": "'",
	"\u2019": "'",
	"&hellip;": "…",
	"&mdash;": "—",
	"&ndash;": "–",
};

function decodeEntitiesOnce(s: string): string {
	let out = s;
	for (const [token, value] of Object.entries(NAMED_ENTITIES)) {
		out = out.split(token).join(value);
	}
	// Numeric entities. Naive fromCodePoint per match breaks when a source
	// emits astral chars as UTF-16 code-unit entities (high+low separately):
	// combining them here keeps emoji intact instead of splitting pairs.
	let pendingHigh = -1;
	out = out.replace(
		/&#(x[0-9a-f]+|\d+);/gi,
		(full: string, n: string): string => {
			const code = n.toLowerCase().startsWith("x")
				? Number.parseInt(n.slice(1), 16)
				: Number.parseInt(n, 10);
			if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff) {
				return full;
			}
			if (code >= 0xd800 && code <= 0xdbff) {
				pendingHigh = code;
				return "";
			}
			if (code >= 0xdc00 && code <= 0xdfff) {
				if (pendingHigh !== -1) {
					const combined =
						0x10000 + ((pendingHigh - 0xd800) << 10) + (code - 0xdc00);
					pendingHigh = -1;
					return String.fromCodePoint(combined);
				}
				return full; // lone low surrogate — leave as-is, don't corrupt
			}
			pendingHigh = -1;
			return String.fromCodePoint(code);
		},
	);
	return out;
}

function decodeEntities(s: string): string {
	return decodeEntitiesOnce(decodeEntitiesOnce(s));
}

interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
}

export const DESCRIPTION_LIMIT = 600;

/** Why an item produced no event: no slug (silently dropped) or a date that
 * cannot exist ("31 de fevereiro" — counted as a failure). */
type ItemOutcome = RawEvent | "no-slug" | "bad-date";

function buildEvent(item: ParsedItem): ItemOutcome {
	const slug = item.link.split("/").filter(Boolean).at(-1) ?? "";
	if (!slug) {
		return "no-slug";
	}
	// descriptionHtml is fully entity-decoded real HTML. Strip tags by regex —
	// cheerio's text() serializer mangles astral-plane chars (📌, 🗣) into lone
	// surrogate halves, which would corrupt venue/date extraction downstream.
	const stripped = item.descriptionHtml
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const date = extractDate(stripped, item.pubDateMs ?? Date.now());
	const img =
		item.descriptionHtml.match(/<img[^>]*\ssrc="([^"]+)"/i)?.[1] ?? null;
	const startAt = date
		? toEpochInLisbonOrNull(
				date.year,
				date.month,
				date.day,
				date.hour,
				date.minute,
			)
		: null;
	if (date && startAt == null) {
		return "bad-date";
	}

	return {
		title: item.title,
		slug,
		description: stripped ? stripped.slice(0, DESCRIPTION_LIMIT) : null,
		startAt,
		endAt: null,
		dateText: date ? null : extractDateText(stripped),
		venueName: extractVenue(stripped),
		city: "Leiria",
		categories: item.categories.filter((c) => !PSEUDO_CATEGORIES.has(c)),
		imageUrl: img,
		url: item.link,
	};
}

/** Build a RawEvent for one parsed feed item (never throws → per-item
 * resilient; null for a missing slug or an impossible calendar date). */
export function parseEvent(item: ParsedItem): RawEvent | null {
	const out = buildEvent(item);
	return typeof out === "string" ? null : out;
}

/** Parse the whole RSS feed into RawEvents. Drop items that have no slug. */
export function parseFeed(xml: string): RawEvent[] {
	return parseFeedCounted(xml).events;
}

/** parseFeed plus a count of items skipped for an impossible date. */
function parseFeedCounted(xml: string): {
	events: RawEvent[];
	failures: number;
} {
	const events: RawEvent[] = [];
	let failures = 0;
	for (const item of parseItems(xml)) {
		const out = buildEvent(item);
		if (out === "bad-date") failures++;
		else if (out !== "no-slug") events.push(out);
	}
	return { events, failures };
}

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
}

/**
 * Fetch and parse the cm-leiria events RSS feed. Failures only accumulate for
 * individual items that could not be turned into an event — the feed itself
 * must load (fetch errors bubble up to the caller).
 */
export async function scrape(
	deps: ScrapeDeps = { fetchText: defaultFetchText },
): Promise<ScrapeResult> {
	const xml = await deps.fetchText(RSS_URL);
	const { events, failures } = parseFeedCounted(xml);
	return {
		events,
		failures,
		firstError: failures > 0 ? "item with an impossible calendar date" : null,
	};
}
