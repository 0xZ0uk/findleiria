import { errorMessage } from "./errors";
import { toEpochInLisbon } from "./fingerprint";
import { defaultFetchText } from "./http";
import { plainText } from "./normalize";
import type { RawEvent } from "./types";

/**
 * turismodocentro — coverage for Turismo do Centro's event board
 * (turismodocentro.pt), an open WordPress REST source. Cheap overflow: two
 * requests, no HTML parsing, no detail fetches.
 *
 * RECON (2026-09-12):
 *   list:     GET /wp-json/wp/v2/event?per_page=100   → 64 rows
 *   concelhos: GET /wp-json/wp/v2/county_mirror?per_page=100 → id → name
 *
 * Every row carries a `centro` object the theme mirrors from the upstream
 * (OutdoorActive-style) feed:
 *   { image, date_line: "12.09.2026" | "13.09.2026<br>20.09.2026",
 *     start_date: <unix seconds>, end_date: <unix seconds> }
 * Those epochs are LOCAL MIDNIGHT of the source's own calendar date (verified:
 * 1789171200 == 2026-09-12T00:00Z for a row whose `date_line` says 12.09.2026),
 * so the UTC calendar parts are the honest day. The board publishes no clock
 * time anywhere on the records — `date_line` carries none across all 64 rows —
 * so rows are day-precision and pinned to Lisbon midnight via toEpochInLisbon,
 * exactly like the regiaoleiria/nocartaz day rows. `dateText` stays null: the
 * pipeline's undated-row path is not involved.
 *
 * Scope: `county_mirror` holds the concelho term ids (a row may hold several
 * when the event runs in more than one municipality). The gate runs per
 * concelho name against the injected district predicate; a row is kept when at
 * least one of its concelhos is in the district, and it is filed under the
 * FIRST in-district concelho (reported as `multiConcelho` so a region-wide
 * event is visible in the run summary instead of passing silently). Rows with
 * no in-district concelho are dropped — never guessed into scope.
 *
 * The source publishes no venue field: `destination_mirror` is a region
 * (e.g. "Região de Leiria"), not a venue. The concelho is therefore both the
 * venue and the city — the same honest, vague fallback the caldas source uses.
 * The description is the post's rendered content, flattened and truncated.
 */

export const SITE = "https://turismodocentro.pt";
export const EVENT_BASE = `${SITE}/wp-json/wp/v2/event`;
export const COUNTY_BASE = `${SITE}/wp-json/wp/v2/county_mirror`;
export const PER_PAGE = 100;
/** Hard cap on listing pages walked (real source: 1 page, 64 rows). */
export const MAX_PAGES = 3;
/** An event is "live" until one day after its local end. */
export const RETRO_TOLERANCE_S = 86_400;
/** Descriptions are a teaser, not an article. */
export const DESCRIPTION_LIMIT = 400;

export interface Centro {
	image: string | null;
	dateLine: string | null;
	startDate: number | null;
	endDate: number | null;
}

export interface TurismoItem {
	id: number;
	slug: string;
	link: string;
	title: string;
	description: string | null;
	imageUrl: string | null;
	countyIds: number[];
	centro: Centro;
}

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Rows returned by the listing, before any gate. */
	discovered: number;
	/** Rows dropped because no concelho of theirs is in the district. */
	droppedOutOfDistrict: number;
	/** Rows dropped because the event is already over. */
	droppedPast: number;
	/** Rows dropped because the feed carries no usable start date. */
	droppedUndated: number;
	/** Kept rows that name more than one in-district concelho. */
	multiConcelho: number;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	now: number;
}

const defaultSleep = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, ms));

/** Calendar parts of a source epoch (UTC parts: the feed pins local midnight). */
export interface DayParts {
	year: number;
	month: number;
	day: number;
}

export function dayParts(epochSeconds: number): DayParts {
	const d = new Date(epochSeconds * 1000);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
	};
}

const asRecord = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const asString = (v: unknown): string =>
	typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

const asNumber = (v: unknown): number | null => {
	const n = typeof v === "number" ? v : Number(asString(v));
	return Number.isFinite(n) && n > 0 ? n : null;
};

const asIdArray = (v: unknown): number[] =>
	Array.isArray(v)
		? v.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
		: [];

/** Parse the `centro` mirror object; missing pieces stay null. */
export function parseCentro(raw: unknown): Centro {
	const c = asRecord(raw);
	const image = asString(c.image).trim();
	return {
		image: image.length > 0 ? image : null,
		dateLine: asString(c.date_line).trim() || null,
		startDate: asNumber(c.start_date),
		endDate: asNumber(c.end_date),
	};
}

/** JSON parse that treats junk as "nothing here" instead of throwing. */
function tryParse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** Parse the event listing JSON. Malformed rows are skipped, not guessed at. */
export function parseItems(text: string): TurismoItem[] {
	const parsed = tryParse(text);
	if (!Array.isArray(parsed)) {
		return [];
	}
	const items: TurismoItem[] = [];
	for (const row of parsed) {
		const r = asRecord(row);
		const id = asNumber(r.id);
		const slug = asString(r.slug).trim();
		const link = asString(r.link).trim();
		const titleHtml = asString(asRecord(r.title).rendered);
		const title = plainText(titleHtml);
		if (id === null || !slug || !link || !title) {
			continue;
		}
		const content = plainText(asString(asRecord(r.content).rendered));
		const excerpt = plainText(asString(asRecord(r.excerpt).rendered));
		const description = content || excerpt;
		const centro = parseCentro(r.centro);
		items.push({
			id,
			slug,
			link,
			title,
			description:
				description.length > 0 ? description.slice(0, DESCRIPTION_LIMIT) : null,
			imageUrl: centro.image,
			countyIds: asIdArray(r.county_mirror),
			centro,
		});
	}
	return items;
}

/** Parse a WP taxonomy listing into an id → name map. */
export function parseTerms(text: string): Map<number, string> {
	const parsed = tryParse(text);
	const map = new Map<number, string>();
	if (!Array.isArray(parsed)) {
		return map;
	}
	for (const row of parsed) {
		const r = asRecord(row);
		const id = asNumber(r.id);
		const name = asString(r.name).trim();
		if (id !== null && name) {
			map.set(id, name);
		}
	}
	return map;
}

export type DropReason = "outOfDistrict" | "past" | "undated";

export interface Conversion {
	raw: RawEvent | null;
	reason: DropReason | null;
	/** In-district concelhos the row names (kept rows carry ≥ 1). */
	inDistrict: string[];
}

/**
 * Turn one listing row into a RawEvent (or report why it cannot be one).
 * `isInScope` is the district predicate; it is applied to concelho names, so
 * the scope rule lives in one place.
 */
export function toRawEvent(
	item: TurismoItem,
	counties: Map<number, string>,
	isInScope: (city: string | null | undefined) => boolean,
	now: number,
): Conversion {
	const startEpoch = item.centro.startDate;
	if (startEpoch === null) {
		return { raw: null, reason: "undated", inDistrict: [] };
	}
	const start = dayParts(startEpoch);
	const startAt = toEpochInLisbon(start.year, start.month, start.day);
	const endEpoch = item.centro.endDate ?? startEpoch;
	const endParts = dayParts(endEpoch);
	const endAt = toEpochInLisbon(
		endParts.year,
		endParts.month,
		endParts.day,
		23,
		59,
	);
	if (endAt < now - RETRO_TOLERANCE_S) {
		return { raw: null, reason: "past", inDistrict: [] };
	}

	const inDistrict: string[] = [];
	for (const id of item.countyIds) {
		const name = counties.get(id);
		if (name && isInScope(name) && !inDistrict.includes(name)) {
			inDistrict.push(name);
		}
	}
	if (inDistrict.length === 0) {
		return { raw: null, reason: "outOfDistrict", inDistrict };
	}

	const place = inDistrict[0] as string;
	return {
		reason: null,
		inDistrict,
		raw: {
			title: item.title,
			slug: item.slug,
			description: item.description,
			startAt,
			endAt,
			dateText: null,
			venueName: place,
			city: place,
			categories: [],
			imageUrl: item.imageUrl,
			url: item.link,
		},
	};
}

/**
 * Scrape the Turismo do Centro event board: concelho roster + one listing
 * page (paginated only if the source grows past PER_PAGE).
 *
 * Fail-closed on the roster: without the id → concelho map nothing can be
 * gated, so the run reports a failure and emits no events rather than filing
 * every row as out-of-district.
 */
export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (city: string | null | undefined) => boolean = () => true,
): Promise<ScrapeResult> {
	let pagesFetched = 0;
	let failures = 0;
	let firstError: string | null = null;

	const empty: ScrapeResult = {
		events: [],
		failures: 0,
		firstError: null,
		pagesFetched: 0,
		discovered: 0,
		droppedOutOfDistrict: 0,
		droppedPast: 0,
		droppedUndated: 0,
		multiConcelho: 0,
	};

	let counties = new Map<number, string>();
	try {
		counties = parseTerms(
			await deps.fetchText(`${COUNTY_BASE}?per_page=${PER_PAGE}`),
		);
		pagesFetched++;
	} catch (err) {
		failures++;
		firstError = `${COUNTY_BASE}: ${errorMessage(err)}`;
	}
	if (counties.size === 0) {
		return {
			...empty,
			failures: Math.max(failures, 1),
			firstError:
				firstError ?? `${COUNTY_BASE}: empty concelho roster — cannot gate`,
			pagesFetched,
		};
	}

	const items: TurismoItem[] = [];
	const seen = new Set<number>();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = `${EVENT_BASE}?per_page=${PER_PAGE}&page=${page}`;
		let rows: TurismoItem[] = [];
		try {
			await deps.sleep(200 + Math.floor(Math.random() * 200));
			rows = parseItems(await deps.fetchText(url));
			pagesFetched++;
		} catch (err) {
			failures++;
			firstError ??= `${url}: ${errorMessage(err)}`;
			break;
		}
		for (const row of rows) {
			if (!seen.has(row.id)) {
				seen.add(row.id);
				items.push(row);
			}
		}
		if (rows.length < PER_PAGE) {
			break;
		}
	}

	const events: RawEvent[] = [];
	let droppedOutOfDistrict = 0;
	let droppedPast = 0;
	let droppedUndated = 0;
	let multiConcelho = 0;
	for (const item of items) {
		const { raw, reason, inDistrict } = toRawEvent(
			item,
			counties,
			isInScope,
			deps.now,
		);
		if (!raw) {
			if (reason === "outOfDistrict") droppedOutOfDistrict++;
			else if (reason === "past") droppedPast++;
			else droppedUndated++;
			continue;
		}
		if (inDistrict.length > 1) {
			multiConcelho++;
		}
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
		multiConcelho,
	};
}
