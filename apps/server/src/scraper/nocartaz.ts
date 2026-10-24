import {
	knownVenueFor,
	titlePlaceCity,
} from "@events-tracker/api/known-venues";
import { inDistrictScope, isLeiriaDistrict, normalizePlace } from "./district";
import { errorMessage } from "./errors";
import { lisbonDateTime, toEpochInLisbonOrNull } from "./fingerprint";
import { defaultFetchText } from "./http";
import { textOf } from "./lib/html";
import { findJsonLdEvent, flattenJsonLd, jsonLdBlocks } from "./lib/jsonld";
import { defaultSleep, randomDelay } from "./lib/timing";
import { decodeEntities, venueTokens } from "./normalize";
import { loadState, saveState } from "./state";
import type { RawEvent } from "./types";

/**
 * nocartaz — venue-hub aggregator (SLICE_10 Tier 2, promoted to a shared
 * source once the hub turned out to be server-rendered).
 *
 * Earlier recon filed this site as Tier 2 because `/eventos/` (the national
 * index) is a JS-driven shell. The *district* hubs are not: `/distrito/<slug>/`
 * is an Astro page that renders every card server-side, so one request returns
 * the whole district roster — no pagination, no JSON-LD index needed.
 *
 *   listing   https://www.nocartaz.pt/distrito/leiria/
 *   cards     `article.event-card` + `data-*` attributes (203 live 2026-09-12)
 *   detail    /eventos/<16-hex-id>/ with a schema.org Event (@type Event,
 *             Festival, MusicEvent…) carrying name, startDate, location
 *             (Place > PostalAddress.addressLocality) and description.
 *
 * What the card already carries, per event:
 *   data-id         the site's own event id — used as this source's event key
 *   data-concelho   the hub's filing (EMPTY for aggregator-fed rows)
 *   data-venue      venue slug (`tjls-leiria`, `bandsintown-leiria`, …)
 *   data-date       `YYYY-MM-DD`
 *   data-starts-at  `YYYY-MM-DDTHH:mm:ss`, WITH a `+01:00` suffix on some rows
 *                   and bare Lisbon wall clock on others — both shapes are
 *                   accepted, see `epochFromRaw`
 *   data-genre      slug taxonomy (`literatura`, `rock-pop`, `exposicao`, …)
 *   data-free       `1` for free entry; `0` on every other row, aggregator and
 *                   municipal feeds included, so it only ever proves "free"
 *
 * District gate. The hub files cards by concelho, and for its own venue hubs
 * that value is a real Leiria-district concelho. Rows it picked up from
 * aggregator feeds (bandsintown / 3cket / ecultura) sometimes carry NO
 * concelho and are not in the district at all — live example: a concert at
 * "Sociedade Recreativa Operária de Santarém" parked on the Leiria hub. The
 * gate therefore runs on the RESOLVED city (detail `addressLocality`, falling
 * back to the card's own concelho), never on the route label.
 *
 * End dates: the detail JSON-LD carries NO `endDate`, even for multi-day
 * festivals — the range lives only in prose ("de 4 a 13 de setembro em…"). So
 * `endAt` stays null rather than being invented from a sentence; a
 * multi-day festa ships as a single-day card dated on its first day.
 *
 * Incremental state (`state/nocartaz.json`): `{ details: { <id>: … } }` — the
 * parsed detail of every card currently on the page. A card whose detail is
 * cached is emitted from the cache (no refetch), so the description/image a
 * second run writes never degrades to card-only data; unseen ids fetch once,
 * and the map is pruned to the ids the page still lists.
 *
 * SLICE_17 — rows the hub cannot localize. A row NoCartaz cannot place carries
 * `data-concelho=""`, an empty `.where` span, a blank Sala/Concelho on its
 * detail page ("Portugal ()") and an `addressRegion` that is only the
 * aggregator's guess. The district gate has nothing to gate on, so the event was
 * dropped. Two things now happen instead:
 *
 *   venue evidence  the venue name is taken from the detail, the card, or — for
 *                   aggregator-fed rows, where it is the only mention — the
 *                   card title's ` @ ` suffix ("Baleia Baleia Baleia @ O Pica
 *                   Miolos"). A venue curated in @events-tracker/api/known-venues
 *                   is in-district evidence by itself, and its concelho becomes
 *                   the event's city (a Leiria bar must never ship as Coimbra).
 *   all hubs        the misfiled row lives on the hub of the aggregator's own
 *                   region guess — O Pica Miolos, a Leiria bar, sits on the
 *                   COIMBRA hub — so every district hub is scanned, and only
 *                   allowlist hits are kept from districts other than Leiria.
 *
 * Title text is also the last resort for rows that name no venue at all (3cket,
 * ecultura, ticketline, bol, blueticket, dgartes feeds): when the row has no
 * locality, a district municipality named in the TITLE places it (see
 * `titlePlaceCity`).
 */

export const ORIGIN = "https://www.nocartaz.pt";
export const LISTING = `${ORIGIN}/distrito/leiria/`;

/**
 * Every district hub the site publishes, Leiria first (SLICE_17). The Leiria
 * hub is the primary listing and its failure fails the source; the other 19 are
 * a best-effort scan that keeps ONLY rows whose venue matches the curated
 * allowlist — never another district's events wholesale.
 */
export const DISTRICT_HUBS: readonly string[] = [
	"leiria",
	"acores",
	"aveiro",
	"beja",
	"braga",
	"braganca",
	"castelo-branco",
	"coimbra",
	"evora",
	"faro",
	"guarda",
	"lisboa",
	"madeira",
	"portalegre",
	"porto",
	"santarem",
	"setubal",
	"viana-do-castelo",
	"vila-real",
	"viseu",
];

export const hubUrl = (slug: string): string => `${ORIGIN}/distrito/${slug}/`;

/** Safety net on detail fetches per run; unseen ids are retried next run. */
export const MAX_DETAIL_REQUESTS = 400;
/**
 * A source date counts as live until one day past its end. Gates the "already
 * over" drop in `toRawEvent`: an open-ended gig (no end) or a date-only card
 * is still on until the end of its Lisbon day, which ingest honours, so this
 * gate must not cut it earlier.
 */
export const PAST_TOLERANCE_S = 86_400;

/**
 * `data-genre` slug → canonical category. Slugs are the hub's own taxonomy;
 * the canonical labels are the ones `canonicalizeCategories` already knows, so
 * a genre with no mapping is dropped instead of leaking a slug into the
 * filter dropdown.
 */
export const GENRE_CATEGORIES: Record<string, string> = {
	literatura: "Literatura",
	conferencia: "Conferências",
	"rock-pop": "Concertos",
	jazz: "Concertos",
	"musica-classica": "Concertos",
	opera: "Concertos",
	folk: "Concertos",
	eletronica: "Clubbing",
	exposicao: "Museus & Exposições",
	festival: "Festivais",
	cinema: "Cinema",
	infantil: "Infantil",
	teatro: "Teatro",
	performance: "Teatro",
	outro: "Outros",
};

export function categoriesFor(genre: string): string[] {
	const label = GENRE_CATEGORIES[genre.trim().toLowerCase()];
	return label ? [label] : [];
}

/**
 * `data-venue` is the FEED a row came from (`museu-vidro-marinha-grande`,
 * `cm-mgrande-eventos`, `agenda-obidos`), and for feed-fed rows the venue
 * field repeats the feed's own name instead of naming a room — live examples:
 * a beach walk in São Pedro de Moel filed under "Museu do Vidro - Marinha
 * Grande", a photography biennial under "Festas de Nossa Senhora da Nazaré —
 * Sítio", a CM agenda as "Câmara Municipal da Marinha Grande - Agenda". Such a
 * row knows its concelho, not its venue: shipping the feed name both lies on
 * the card and blocks cross-source fusion (identity groups by title+day and
 * then needs compatible venues), which is what the collected dupes looked like.
 * Two signals, both from the live page: the venue name repeats the feed slug's
 * words, or it is labelled "agenda".
 */
export function isFeedVenue(slug: string, venue: string): boolean {
	const slugTokens = venueTokens(slug.replace(/[-/]/g, " "));
	const nameTokens = new Set(venueTokens(venue));
	if (
		slugTokens.length > 0 &&
		slugTokens.every((token) => nameTokens.has(token))
	) {
		return true;
	}
	return /agenda/i.test(venue);
}

export interface NocartazCard {
	/** the site's own event id (`06009145e171bc07`) */
	id: string;
	title: string;
	/** venue display name, without the `· Concelho` chip */
	venue: string;
	/** `data-concelho`, empty on aggregator-fed rows */
	city: string;
	/** `data-date` — day granularity, always present */
	date: string;
	/** `data-starts-at` — clock time, offset-suffixed on some rows */
	startsAt: string;
	genre: string;
	free: boolean;
	/** `.when` chip, e.g. `sex 11 set · 21:30` — day-precision `dateText` */
	when: string;
	/** `data-venue` — the hub feed the row came from (`tjls-leiria`) */
	venueSlug: string;
	description: string | null;
	imageUrl: string | null;
	url: string;
}

export interface NocartazDetail {
	title: string | null;
	startAt: string | null;
	endAt: string | null;
	venue: string | null;
	city: string | null;
	description: string | null;
	imageUrl: string | null;
}

/**
 * Cached parse of one detail page — the shape stored in state. `cardWhen` is
 * the date the LISTING showed (minute-precision Lisbon wall clock) when the
 * detail was fetched: when the card's date later changes the event was
 * rescheduled and the cached detail (whose `startAt` beats the card's) is
 * stale, so it is refetched. Entries from before this field existed have no
 * `cardWhen` and count as stale once.
 */
export type CachedDetail = NocartazDetail & { cardWhen?: string };

/** The date a listing card shows, normalised for change detection; null when it shows none. */
export function listedWhen(card: NocartazCard): string | null {
	const epoch = epochFromRaw(card.startsAt) ?? epochFromRaw(card.date);
	return epoch == null ? null : lisbonDateTime(epoch);
}

/** Whether a cached detail predates the date its card now lists. */
export function isDetailStale(
	cached: CachedDetail,
	card: NocartazCard,
): boolean {
	const listed = listedWhen(card);
	// ItemList-only cards carry no date: nothing to compare, keep the cache.
	return listed !== null && cached.cardWhen !== listed;
}

export interface NocartazState {
	details: Record<string, CachedDetail>;
}

export const DEFAULT_STATE: NocartazState = { details: {} };

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Cards found on the hub page. */
	discovered: number;
	/** Saves the detail cache; the runner calls it after ingest (C7). Absent when the primary hub failed. */
	commit?: () => void;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	loadState: () => NocartazState;
	saveState: (s: NocartazState) => void;
	now: number;
	/**
	 * District hubs to scan, primary (Leiria) first. Defaults to every hub the
	 * site publishes; tests narrow it so they do not have to stub 20 pages.
	 */
	hubs?: readonly string[];
}

function cardAttr(attrs: string, name: string): string {
	const m = new RegExp(`data-${name}="([^"]*)"`).exec(attrs);
	return m ? decodeEntities(m[1] ?? "").trim() : "";
}

/**
 * Every card the hub renders. The `data-*` attributes are the machine-readable
 * half; the title/venue/description come from markup, so both are read here
 * and the attribute wins whenever the two disagree.
 */
export function parseCards(html: string): NocartazCard[] {
	const out: NocartazCard[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(
		/<article class="event-card[^"]*"([^>]*)>([\s\S]*?)<\/article>/g,
	)) {
		const attrs = match[1] ?? "";
		const body = match[2] ?? "";
		const id = cardAttr(attrs, "id");
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);

		// `<span class="where"><span>Venue</span><span class="concelho">· City</span></span>`
		const where =
			/class="where">([\s\S]*?)<\/span>\s*<div/.exec(body)?.[1] ?? "";
		const cityChip = /<span class="concelho">([\s\S]*?)<\/span>/.exec(
			where,
		)?.[1];
		const venue = /<span>([\s\S]*?)<\/span>/.exec(where)?.[1];

		out.push({
			id,
			title: textOf(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(body)?.[1] ?? ""),
			venue: venue ? textOf(venue) : "",
			city: cityChip
				? textOf(cityChip).replace(/^[·\s]+/, "")
				: cardAttr(attrs, "concelho"),
			date: cardAttr(attrs, "date"),
			startsAt: cardAttr(attrs, "starts-at"),
			genre: cardAttr(attrs, "genre"),
			free: cardAttr(attrs, "free") === "1",
			when: textOf(
				/class="when"[^>]*>([\s\S]*?)<\/span>/.exec(body)?.[1] ?? "",
			),
			venueSlug: cardAttr(attrs, "venue"),
			description:
				textOf(/<p class="pitch-line">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? "") ||
				null,
			imageUrl:
				/<div class="card-thumb">[\s\S]*?<img[^>]+src="([^"]+)"/.exec(
					body,
				)?.[1] ?? null,
			url: `${ORIGIN}/eventos/${id}/`,
		});
	}
	return out;
}

/**
 * The venue a card title names, when the markup does not name one (SLICE_17).
 *
 * Aggregator-fed rows are titled `<artist> @ <venue>` and carry an EMPTY
 * `.where` span — "Baleia Baleia Baleia @ O Pica Miolos" is the only place the
 * venue reaches us. The LAST `@` wins so an artist name containing one cannot
 * steal the split; a suffix that is empty or implausibly long (prose, not a
 * room) is refused rather than guessed.
 */
export function titleVenue(title: string | null | undefined): string | null {
	const text = (title ?? "").trim();
	const at = text.lastIndexOf("@");
	if (at < 1) {
		return null;
	}
	const left = text.slice(0, at).trim();
	const venue = text.slice(at + 1).trim();
	if (left.length === 0 || venue.length === 0 || venue.length > 60) {
		return null;
	}
	return venue;
}

/**
 * `location.name` is the room for a normal row and the literal country for an
 * aggregator-fed one ("Portugal"). A country is not a venue — such a row takes
 * its venue from the card or the title instead.
 */
const COUNTRY_PLACEHOLDERS = new Set([
	"portugal",
	"portugal continental",
	"pt",
]);

function usableVenueName(name: string | null | undefined): string | null {
	const value = (name ?? "").trim();
	if (value.length === 0) {
		return null;
	}
	return COUNTRY_PLACEHOLDERS.has(normalizePlace(value)) ? null : value;
}

/**
 * How a card names its venue: the `.where` text when it has one, else the
 * title's ` @ ` suffix. This is the evidence the allowlist scan matches on, so
 * it is also what decides whether an off-district hub card is worth a detail
 * fetch at all.
 */
export function cardVenueEvidence(card: NocartazCard): string | null {
	return usableVenueName(card.venue) ?? titleVenue(card.title);
}

/** One event link carried by a hub's JSON-LD `ItemList`. */
export interface ItemListEntry {
	id: string;
	name: string;
}

/**
 * The hub's `ItemList` — 30 events INCLUDING today, where the card grid starts
 * tomorrow and stops at its own cap. On the Leiria hub it is a second chance at
 * rows the grid drops; on every other hub it is where a misfiled row shows up
 * at all (both O Pica Miolos events are only in the Coimbra hub's list).
 */
export function parseItemList(html: string): ItemListEntry[] {
	const out: ItemListEntry[] = [];
	const seen = new Set<string>();
	for (const block of jsonLdBlocks(html)) {
		for (const node of flattenJsonLd(block)) {
			const list = node as { "@type"?: unknown; itemListElement?: unknown[] };
			if (list["@type"] !== "ItemList") {
				continue;
			}
			for (const raw of list.itemListElement ?? []) {
				const item = raw as { name?: unknown; url?: unknown };
				const url = typeof item?.url === "string" ? item.url : "";
				const name =
					typeof item?.name === "string" ? decodeEntities(item.name) : "";
				const id = /\/eventos\/([0-9a-f]+)\//.exec(url)?.[1] ?? "";
				if (id.length === 0 || name.trim().length === 0 || seen.has(id)) {
					continue;
				}
				seen.add(id);
				out.push({ id, name: name.trim() });
			}
		}
	}
	return out;
}

/**
 * An `ItemList` entry as a card: the list gives an id and a title, and nothing
 * else — the detail page supplies the date the gate needs, so an entry whose
 * detail cannot be fetched is simply not emitted (and retried next run). The
 * genre is unknown to the list, so categories stay empty rather than inferred.
 */
export function itemListCard(entry: ItemListEntry): NocartazCard {
	return {
		id: entry.id,
		title: entry.name,
		venue: "",
		city: "",
		date: "",
		startsAt: "",
		genre: "",
		free: false,
		when: "",
		venueSlug: "",
		description: null,
		imageUrl: null,
		url: `${ORIGIN}/eventos/${entry.id}/`,
	};
}

/**
 * The detail page's event node. Deliberately NOT type-matched: the hub's
 * pages are trusted to carry one dated node, so the first node (in any
 * block, array or `@graph`) with a string `startDate` wins.
 */
function eventNode(html: string): Record<string, unknown> | null {
	return findJsonLdEvent(html, {
		accept: (node) => typeof node.startDate === "string",
	});
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? decodeEntities(value).trim()
		: null;
}

export function parseDetail(html: string): NocartazDetail {
	const node = eventNode(html);
	if (!node) {
		return {
			title: null,
			startAt: null,
			endAt: null,
			venue: null,
			city: null,
			description: null,
			imageUrl: null,
		};
	}
	const location = (node.location ?? {}) as {
		name?: unknown;
		address?: { addressLocality?: unknown };
	};
	const image = Array.isArray(node.image) ? node.image[0] : node.image;
	return {
		title: str(node.name),
		startAt: str(node.startDate),
		endAt: str(node.endDate),
		venue: str(location.name),
		city: str(location.address?.addressLocality),
		description: str(node.description),
		imageUrl: str(image),
	};
}

/**
 * Epoch seconds for either shape the hub publishes: an absolute timestamp
 * (`2026-09-19T20:00:11+01:00`) or Lisbon wall clock with no zone at all
 * (`2026-09-13T00:00:00`). The second shape is read against Europe/Lisbon
 * rather than the host clock, so a container in UTC does not shift a 21:30
 * concert onto the next day.
 */
export function epochFromRaw(raw: string | null | undefined): number | null {
	if (!raw) {
		return null;
	}
	const value = raw.trim();
	if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
	if (!m?.[1] || !m[2] || !m[3]) {
		return null;
	}
	// null for an impossible calendar date in the source chip
	return toEpochInLisbonOrNull(
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		m[4] ? Number(m[4]) : 0,
		m[5] ? Number(m[5]) : 0,
	);
}

export function toRawEvent(
	card: NocartazCard,
	detail: NocartazDetail | null,
	now: number,
	isInScope: (
		city: string | null | undefined,
		venueEvidence?: string | null,
	) => boolean,
): RawEvent | null {
	const title = (detail?.title ?? card.title).replace(/\s+/g, " ").trim();
	if (!title) {
		return null;
	}

	// Venue evidence, best first: the detail's own room name, the card's, then
	// the name the title carries — which for an aggregator-fed row is the only
	// mention of the venue anywhere on the row.
	const venueEvidence =
		usableVenueName(detail?.venue) ??
		usableVenueName(card.venue) ??
		titleVenue(card.title);
	const known = knownVenueFor(venueEvidence) ?? knownVenueFor(card.title);
	const rowCity = ((detail?.city ?? card.city) || "").trim() || null;
	const rowCityInDistrict = isLeiriaDistrict(rowCity);

	// The row's own locality decides first, then a curated venue, then — only
	// when the row carries NO locality at all — a district municipality named in
	// the title. That order is the whole point: a title can never override a
	// real, out-of-district city.
	let inScope = isInScope(rowCity, venueEvidence);
	if (!inScope && known) {
		inScope = true;
	}
	if (!inScope && !rowCity) {
		inScope =
			titlePlaceCity(card.title) !== null || titlePlaceCity(title) !== null;
	}
	if (!inScope) {
		return null;
	}

	// A venue we curated is a fact; the aggregator's region guess is not. A row
	// filed under Coimbra still ships with its true concelho — an event is never
	// left placeless or mislabelled because the upstream could not localize it.
	const city =
		(rowCityInDistrict ? rowCity : null) ??
		known?.city ??
		titlePlaceCity(venueEvidence) ??
		titlePlaceCity(card.title) ??
		titlePlaceCity(title) ??
		rowCity;

	const startAt =
		epochFromRaw(detail?.startAt) ??
		epochFromRaw(card.startsAt) ??
		epochFromRaw(card.date);
	if (startAt == null) {
		// The hub always dates its cards; a card without a readable date is a
		// markup change, not a dateless event — drop it rather than mint one.
		return null;
	}

	let endAt = epochFromRaw(detail?.endAt);
	if (endAt != null && endAt <= startAt) {
		endAt = null;
	}
	if ((endAt ?? startAt) + PAST_TOLERANCE_S < now) {
		return null; // already over
	}

	const venue = (venueEvidence ?? "").trim();
	// Feed rows name the feed, not a room (see isFeedVenue): the concelho is
	// the most specific place such a row actually knows.
	const cityLabel = city ?? "";
	const venueName = isFeedVenue(card.venueSlug, venue)
		? cityLabel || venue
		: venue || cityLabel;

	return {
		title,
		slug: `nocartaz-${card.id}`,
		description: detail?.description ?? card.description,
		startAt,
		endAt,
		// `date_text` marks UNDATED rows (they never expire and the digest lists
		// them separately) and the reconcile pass skips them — every card here
		// carries a machine date, so it stays null. A card with no clock time
		// gets its day at midnight, the same convention regiaoleiria uses.
		dateText: null,
		venueName,
		city,
		categories: categoriesFor(card.genre),
		imageUrl: card.imageUrl ?? detail?.imageUrl ?? null,
		url: card.url,
		// `data-free="0"` is the default on rows nobody priced (a municipal
		// agenda, a Bandsintown feed), not a price: it never means "paid".
		isFree: card.free ? true : null,
	};
}

export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		loadState: () => loadState("nocartaz", DEFAULT_STATE),
		saveState: (s) => saveState("nocartaz", s),
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (
		city: string | null | undefined,
		venueEvidence?: string | null,
	) => boolean = (city, venueEvidence) => inDistrictScope(city, venueEvidence),
): Promise<ScrapeResult> {
	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;
	let detailRequests = 0;
	const delay = () => deps.sleep(randomDelay());

	const state = deps.loadState();
	const cached = state.details;

	// The primary hub comes first and its failure is the source's failure. The
	// rest are the SLICE_17 scan for rows filed on the wrong district.
	const hubs = deps.hubs ?? DISTRICT_HUBS;
	const primary = hubs[0] ?? "leiria";

	// One attempt: http.ts owns retries (and the 4xx/Retry-After policy), so
	// wrapping it here would stack up to 9 requests per page.
	let html: string;
	try {
		await delay();
		html = await deps.fetchText(hubUrl(primary));
		pagesFetched++;
	} catch (err) {
		return {
			events: [],
			failures: failures + 1,
			firstError: `${hubUrl(primary)}: ${errorMessage(err)}`,
			pagesFetched,
			discovered: 0,
		};
	}

	const candidates: NocartazCard[] = [];
	const seenIds = new Set<string>();
	const push = (card: NocartazCard) => {
		if (seenIds.has(card.id)) {
			return;
		}
		seenIds.add(card.id);
		candidates.push(card);
	};

	// On the Leiria hub every card is a candidate — the gate decides later — and
	// the JSON-LD ItemList joins them, since it carries today's events the card
	// grid drops at its own cap.
	for (const card of parseCards(html)) {
		push(card);
	}
	for (const entry of parseItemList(html)) {
		push(itemListCard(entry));
	}
	if (candidates.length === 0) {
		// The primary hub always lists events: a page that parses to nothing is a
		// markup change (or a challenge page), not a quiet day.
		failures++;
		firstError ??= `${hubUrl(primary)}: listing parsed to zero cards`;
	}

	// Then every other district hub, best effort. A row NoCartaz cannot localize
	// is filed on the hub of the aggregator's own region guess, so a venue we
	// know by fact can sit on any of them (O Pica Miolos, a Leiria bar, is on
	// Coimbra). Only allowlist hits are kept — another district's roster is
	// never ingested wholesale.
	for (const slug of hubs.slice(1)) {
		try {
			await delay();
			const hubHtml = await deps.fetchText(hubUrl(slug));
			pagesFetched++;
			for (const card of parseCards(hubHtml)) {
				if (
					knownVenueFor(cardVenueEvidence(card)) ??
					knownVenueFor(card.title)
				) {
					push(card);
				}
			}
			for (const entry of parseItemList(hubHtml)) {
				if (knownVenueFor(entry.name)) {
					push(itemListCard(entry));
				}
			}
		} catch (err) {
			// A hub we could not read costs us possible allowlist hits, not the
			// day's Leiria scrape: report it and carry on.
			failures++;
			firstError ??= `${hubUrl(slug)}: ${errorMessage(err)}`;
		}
	}

	const cards = candidates;
	const events: RawEvent[] = [];
	// Only ids the page still lists stay cached: the hub drops an event once it
	// is over, so the map tracks the live roster instead of growing forever.
	const details: Record<string, CachedDetail> = {};

	for (const card of cards) {
		const hit = cached[card.id];
		// A cached detail is reused only while the card still lists the date it
		// was fetched under; a rescheduled event refetches (its old startAt would
		// otherwise beat the card's fresh date forever).
		let detail: CachedDetail | null =
			hit && !isDetailStale(hit, card) ? hit : null;
		if (!detail) {
			if (detailRequests < MAX_DETAIL_REQUESTS) {
				try {
					await delay();
					const detailHtml = await deps.fetchText(card.url);
					pagesFetched++;
					detailRequests++;
					const when = listedWhen(card);
					detail = {
						...parseDetail(detailHtml),
						...(when ? { cardWhen: when } : {}),
					};
				} catch (err) {
					// Keep the card: its own attributes are enough for a card.
					// Nothing is cached, so the detail is retried next run.
					failures++;
					firstError ??= `${card.url}: ${errorMessage(err)}`;
					detail = null;
				}
			} else {
				failures++;
				firstError ??= `${card.url}: detail budget exhausted`;
			}
		}
		if (detail) {
			details[card.id] = detail;
		}
		const raw = toRawEvent(card, detail, deps.now, isInScope);
		if (raw) {
			events.push(raw);
		}
	}

	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered: cards.length,
		// Deferred (C7): the cache is saved only after ingest committed, so a
		// failed ingest refetches the same details instead of trusting them.
		commit: () => deps.saveState({ details }),
	};
}
