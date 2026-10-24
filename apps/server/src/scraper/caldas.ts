import { errorMessage } from "./errors";
import { toEpochInLisbon } from "./fingerprint";
import { defaultFetchText } from "./http";
import { monthFromName } from "./lib/pt-dates";
import { defaultSleep, randomDelay } from "./lib/timing";
import { decodeEntities } from "./normalize";
import { loadState, saveState } from "./state";
import type { RawEvent } from "./types";

/**
 * caldas — depth source for the Município de Caldas da Rainha agenda (mcr.pt).
 *
 * mcr.pt is a Next.js municipal site. RECON (2026-09-11) ruled out the
 * merchant-CMS widgets (`event_detail`, `atc_date_start`, `widget_field`
 * "Local:" label) that the task hypothesised — none are present. The agenda
 * is served twice: a clean server-rendered paginated index below, and detail
 * pages whose RSC payload carries `location`/`schedule`/dates with a
 * +00:00 (UTC) offset that the site renders buggy (the visible date card is
 * off by one vs the API's own naive field). Task rule: build the parser on
 * the server-rendered alternative index when the widget path is absent, and
 * do not read Z/UTC-marked fields as wall-clock. So:
 *
 *   Listing: `/agenda?lang=pt&page=N&amount=12`. Server-rendered `events-card`
 *   blocks, 12 per page, totalPages tells the real count (34 on first run;
 *   page walks until one yields zero novel slugs). Each card exposes the slug
 *   (href), title, category, and the authoritative LOCAL start/end dates
 *   (day / "set." month / two-digit year). Detail pages are NOT fetched:
 *   venue and description live only in the fragile RSC `data` blob (+ a buggy
 *   date card), and the contract forbids guessing — unknown venue falls back
 *   to the vague city-level "Caldas da Rainha", description stays null.
 *
 * Dates: reconstructed from the card's day/month/'YY straight into Europe/
 * Lisbon wall-clock via toEpochInLisbon — the fields are local, never UTC.
 * Events whose end is already past are dropped (RETRO_TOLERANCE_S), never
 * rolled forward.
 *
 * Scope: everything on the municipal agenda sits in Caldas da Rainha concelho
 * (= Distrito de Leiria), so isInScope gates on the city alias and drops
 * nothing in practice, but the same injectable hook is kept for tests.
 *
 * Incremental state (`state/caldas.json`): `{ seen: string[] }` of slugs
 * already processed. Steady-state runs re-walk the 3 cheap listing pages to
 * discover new slugs but only emit/record ones not yet seen.
 */

export const SITE = "https://www.mcr.pt";
export const AGENDA_PATH = "/agenda";
export const PAGE_SIZE = 12;
/** Hard cap on listing pages walked (real site: 3 pages, 34 events). */
export const MAX_LISTING_PAGES = 5;
/** An event is "live" until one day after its local end. */
export const RETRO_TOLERANCE_S = 86_400;

export interface CaldasState {
	seen: string[];
}

export const DEFAULT_STATE: CaldasState = { seen: [] };

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Unique event slugs seen across listing pages. */
	discovered: number;
	/** Saves the new seen slugs; the runner calls it after ingest (C7). */
	commit: () => void;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	loadState: () => CaldasState;
	saveState: (s: CaldasState) => void;
	now: number;
}

/** Lisbon wall-clock derived from a card date tuple. */
export interface CardDate {
	day: number;
	month: number;
	year: number;
}

export interface ListingCard {
	slug: string;
	title: string;
	category: string | null;
	start: CardDate;
	end: CardDate;
}

/** Decode the entities the listing cards emit — shared with every other
 * source so there is exactly one implementation (see `./normalize`). */
export { decodeEntities };

/** Turn a raw card date field into a {day, month, year} tuple. */
export function parseCardDate(
	dayRaw: string,
	monthRaw: string,
	yearRaw: string,
): CardDate {
	const day = Number(dayRaw.replace(/[^0-9]/g, ""));
	const monthStr = decodeEntities(monthRaw)
		.replace(/[^a-z]/gi, "")
		.toLowerCase()
		.slice(0, 3);
	const month = monthFromName(monthStr);
	const year =
		2000 +
		Number(
			decodeEntities(yearRaw)
				.replace(/[^0-9]/g, "")
				.slice(-2),
		);
	if (!month) {
		throw new Error(`Unrecognized month token "${monthStr}" in card date`);
	}
	if (!Number.isFinite(day) || day < 1 || day > 31) {
		throw new Error(`Unrecognized day token "${dayRaw}" in card date`);
	}
	return { day, month, year };
}

const pick = (block: string, re: RegExp): string | null =>
	re.exec(block)?.[1] ?? null;

/**
 * Parse every server-rendered `events-card` block on a listing page.
 *
 * Card dates come from three separate spans and can be malformed (unknown
 * month token, `31` in a 30-day month, a stub card). Those cards are skipped
 * and reported through `onMalformed` instead of throwing: this runs inside
 * `scrape()`, and the runner walks every source of the district in one batch,
 * so one corrupt card used to abort the whole run — no run row, no remaining
 * sources. The optional callback lets a parse failure reach
 * `ScrapeResult.failures` / `firstError` the way a fetch failure does.
 */
export function parseListingCards(
	html: string,
	onMalformed?: (reason: string) => void,
): ListingCard[] {
	const blocks = html.split('<div class="events-card">').slice(1);
	const cards: ListingCard[] = [];
	for (const b of blocks) {
		const slug = pick(b, /href="\/agenda\/([^"]+)"/);
		if (!slug) {
			continue;
		}
		const title = pick(b, /__card-title"><span>([^<]*)<\/span><\/h2>/);
		const category = pick(b, /__card-category">([^<]*)</);
		const sDay = pick(b, /__start-date__day">([^<]*)</);
		const sMonth = pick(b, /__start-date__month">([^<]*)</);
		const sYear = pick(b, /__start-date__year">([^<]*)</);
		const eDay = pick(b, /__end-date__day">([^<]*)</);
		const eMonth = pick(b, /__end-date__month">([^<]*)</);
		const eYear = pick(b, /__end-date__year">([^<]*)</);
		if (!title || !sDay || !sMonth || !sYear) {
			continue;
		}
		let start: CardDate;
		try {
			start = parseCardDate(sDay, sMonth, sYear);
		} catch (err) {
			onMalformed?.(`${slug}: start date — ${errorMessage(err)}`);
			continue;
		}
		// Single-day cards (e.g. Futsal) omit the end-date block entirely.
		let end: CardDate = { ...start };
		if (eDay && eMonth && eYear) {
			try {
				end = parseCardDate(eDay, eMonth, eYear);
			} catch (err) {
				// Keep the card as a single-day event rather than dropping it:
				// the start date is the part the listing actually showed, and
				// the unusable end date is still reported as a failure.
				onMalformed?.(`${slug}: end date — ${errorMessage(err)}`);
			}
		}
		cards.push({
			slug,
			title: decodeEntities(title).trim(),
			category: category ? decodeEntities(category).trim() : null,
			start,
			end,
		});
	}
	return cards;
}

/** Stable source id from the agenda slug. */
export function slugFor(slug: string): string {
	return `cl-${slug.replace(/^\/+|\/+$/g, "")}`;
}

/** Lisbon epochs for a card's start/end (end pinned to 23:59 local). */
export function cardEpochs(card: ListingCard): {
	startAt: number;
	endAt: number;
} {
	const startAt = toEpochInLisbon(
		card.start.year,
		card.start.month,
		card.start.day,
		0,
		0,
	);
	const endAt = toEpochInLisbon(
		card.end.year,
		card.end.month,
		card.end.day,
		23,
		59,
	);
	return { startAt, endAt };
}

export const DEFAULT_VENUE = "Caldas da Rainha";

/** Card -> RawEvent. Null when the event's end is already past. */
export function toRawEvent(
	card: ListingCard,
	url: string,
	nowUnix: number,
	onMalformed?: (reason: string) => void,
): RawEvent | null {
	let startAt: number;
	let endAt: number;
	try {
		({ startAt, endAt } = cardEpochs(card));
	} catch (err) {
		// An impossible calendar date the listing markup still published
		// (`29 Fev` in a non-leap year is the real one that reached us). Drop
		// the card, but report it: this throw used to escape `scrape()` and
		// take down every remaining source in the run.
		onMalformed?.(`${card.slug}: campaign date — ${errorMessage(err)}`);
		return null;
	}
	if (endAt < nowUnix - RETRO_TOLERANCE_S) {
		return null;
	}
	return {
		title: card.title,
		slug: slugFor(card.slug),
		description: null,
		startAt,
		endAt,
		dateText: null,
		venueName: DEFAULT_VENUE,
		city: DEFAULT_VENUE,
		categories: card.category ? [card.category] : [],
		imageUrl: null,
		url,
	};
}

const listingUrl = (page: number) =>
	page === 1
		? `${SITE}${AGENDA_PATH}?lang=pt&amount=${PAGE_SIZE}`
		: `${SITE}${AGENDA_PATH}?lang=pt&page=${page}&amount=${PAGE_SIZE}`;

/**
 * Scrape the mcr.pt agenda: paginated server-rendered listing → novel
 * `events-card` sl/ugs, district-gated on the city alias (the whole agenda is
 * Caldas da Rainha concelho). `isInScope` injectable for tests.
 */
export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		loadState: () => loadState("caldas", DEFAULT_STATE),
		saveState: (s) => saveState("caldas", s),
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (city: string | null | undefined) => boolean = () => true,
): Promise<ScrapeResult> {
	let pagesFetched = 0;
	let failures = 0;
	let firstError: string | null = null;

	/** Card-level parse failures are run failures too — they are the only
	 * signal we get that the site's markup shifted under us. */
	const onMalformed = (reason: string) => {
		failures++;
		firstError ??= reason;
	};

	const fetchText = deps.fetchText;
	const delay = () => deps.sleep(randomDelay(300, 300));

	const state = deps.loadState();
	const seen = new Set(state.seen);

	const discovered = new Map<string, ListingCard>();
	for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
		const url = listingUrl(page);
		let html: string;
		try {
			await delay();
			html = await fetchText(url);
			pagesFetched++;
		} catch (err) {
			failures++;
			firstError ??= `${url}: ${errorMessage(err)}`;
			// Pages are addressed explicitly (`?page=N`), so one dead page no
			// longer ends discovery for good: `break` here meant every page
			// after the failing one stayed unfetched on every future run too.
			continue;
		}
		const cards = parseListingCards(html, onMalformed);
		for (const c of cards) {
			if (!discovered.has(c.slug)) {
				discovered.set(c.slug, c);
			}
		}
		// Server-rendered pagination ends when a page yields no cards.
		// Walk every data page (the agenda is only 3-4 pages) rather than
		// stopping on a page with no NEW slugs — a steady-state run where page
		// 1 is fully seen must still reach pages 2-3 for newly added items.
		if (cards.length === 0) {
			break;
		}
	}

	// Emit only slugs we've never seen. The listing is already district-local,
	// but the gate still runs on the (injectable) scope predicate.
	const events: RawEvent[] = [];
	const emittedKeys = new Set<string>();
	// Slugs to mark seen once ingest commits (C7): emitted, a same-run
	// duplicate of an emitted card, or out of scope. A card that did not
	// parse, or one already over, stays unseen: cards come from the listing
	// itself, so re-reading them costs no request.
	const handled: string[] = [];
	for (const [slug, card] of discovered) {
		if (seen.has(slug)) {
			continue;
		}
		const url = `${SITE}${AGENDA_PATH}/${slug}`;
		const raw = toRawEvent(card, url, deps.now, onMalformed);
		if (!raw) {
			continue;
		}
		handled.push(slug);
		if (isInScope(raw.city)) {
			// Guard against title+same-day collisions within a run.
			const key = `${raw.title}|${raw.startAt}`;
			if (!emittedKeys.has(key)) {
				emittedKeys.add(key);
				events.push(raw);
			}
		}
	}

	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered: discovered.size,
		commit: () =>
			deps.saveState({ seen: [...new Set([...state.seen, ...handled])] }),
	};
}
