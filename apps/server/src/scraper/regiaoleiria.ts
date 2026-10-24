import { DateTime } from "luxon";

import { isLeiriaDistrict } from "./district";
import { toEpochInLisbon } from "./fingerprint";
import { defaultFetchText } from "./http";
import { decodeEntities } from "./normalize";
import { loadState, saveState } from "./state";
import type { RawEvent } from "./types";

/**
 * Região de Leiria (regiaodeleiria.pt) — JSON source.
 *
 * The outlet runs WordPress with two working REST bases (the published
 * "/api/wp-json/" path 404s on both, so we hit each route where it actually
 * lives):
 *   - discovery rows:  GET /wp-json/user/events/get-by-month?month=M&year=Y
 *     → array of `{ post_id, date }` where `date` is a Europe/Lisbon
 *     wall-clock "YYYY-MM-DD HH:MM:SS" (no timezone marker — never treat a
 *     trailing Z as UTC). Recurring / multi-session events appear once per
 *     dated row, so each row is one RawEvent occurrence.
 *   - detail:          GET /api/wp/v2/cartaz?include=...&per_page=100
 *     → the "Cartaz" custom post type, joined back to the dated rows by
 *     post id. Carries `localidade` (term ids for the place taxonomy),
 *     `meta.tipo` (category hint, e.g. "festa"/"oxigenio") and the permalink.
 *   - place names:     GET /api/wp/v2/localidade?include=...&per_page=100
 *     → term id → name map used for the district gate.
 *
 * The outlet covers Leiria AND the Oeste region, so the DISTRICT GATE is the
 * point: an item is kept only when its localidade name survives
 * normalizePlace + isLeiriaDistrict. Out-of-district / place-less items are
 * dropped and counted (never guessed into scope).
 *
 * Volume control: we fetch the current month plus a ~6-month horizon (7
 * monthly calls), not the 6300+ post history. Detail/place ids are batched
 * via include= (per_page=100) and the whole run is capped by MAX_DETAIL_*
 * constants so a pathological month cannot fan out into thousands of calls.
 *
 * State ("regiaoleiria"): records the horizon months already discovered. The
 * current month is always re-fetched (its roster churns daily) and every post
 * id seen this run gets its detail re-fetched, so steady-state runs still emit
 * fresh events rather than nothing; the (post_id ↔ date) pairing is what keeps
 * it to exactly one RawEvent per (post_id, date). The fingerprint pipeline
 * makes re-ingestion a no-op.
 */
export const BY_MONTH_BASE =
	"https://www.regiaodeleiria.pt/wp-json/user/events/get-by-month";
export const CART_AZ_BASE = "https://www.regiaodeleiria.pt/api/wp/v2/cartaz";
export const LOCALIDADE_BASE =
	"https://www.regiaodeleiria.pt/api/wp/v2/localidade";
export const HORIZON_MONTHS = 6;
export const PER_PAGE = 100;
export const MAX_DETAIL_REQUESTS = 30;
export const MAX_PLACE_REQUESTS = 5;

export interface RegiaoState {
	/** Horizon months ("YYYY-M") whose discovery rows we have already
	 * fetched. Steady-state runs always re-fetch the CURRENT month (its
	 * roster changes daily) and fetch any horizon month not yet watermarked,
	 * so a settled run costs ~1 discovery call + its (bounded) detail. */
	monthsFetched: string[];
}

export const DEFAULT_STATE: RegiaoState = { monthsFetched: [] };

export interface ScrapeResult {
	events: RawEvent[];
	failures: number;
	firstError: string | null;
	pagesFetched: number;
	/** Unique post ids discovered from the monthly rows (pre-gate). */
	discovered: number;
	/** Rows dropped because their place is outside the Leiria district. */
	droppedOutOfDistrict: number;
}

export interface ScrapeDeps {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	loadState: () => RegiaoState;
	saveState: (s: RegiaoState) => void;
	now: number;
}

const defaultSleep = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, ms));

/** Raw `{ post_id, date }` row from the monthly endpoint. */
export interface MonthRow {
	postId: string;
	date: string;
}

/** Parse the by-month JSON array into postId+date rows. */
export function parseMonthRows(text: string): MonthRow[] {
	const raw = JSON.parse(text) as Array<{ post_id?: string; date?: string }>;
	const out: MonthRow[] = [];
	for (const r of raw) {
		const postId = String(r.post_id ?? "").trim();
		const date = (r.date ?? "").trim();
		if (postId && date) {
			out.push({ postId, date });
		}
	}
	return out;
}

/** Parse a "YYYY-MM-DD HH:MM:SS" wall-clock string → {y,m,d,h,min}. */
export function parseWallClock(
	s: string,
): { y: number; m: number; d: number; h: number; min: number } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
	if (!m) {
		return null;
	}
	return {
		y: Number(m[1]),
		m: Number(m[2]),
		d: Number(m[3]),
		h: Number(m[4]),
		min: Number(m[5]),
	};
}

interface CartazItem {
	id: number;
	slug: string;
	link: string;
	title: string;
	localidade: number[];
	tipo: string;
}

/** Parse a cartaz detail array → map keyed by post id. */
export function parseCartaz(text: string): Map<string, CartazItem> {
	const raw = JSON.parse(text) as Array<{
		id?: number;
		slug?: string;
		link?: string;
		title?: { rendered?: string };
		localidade?: number[];
		meta?: { tipo?: string[] };
	}>;
	const out = new Map<string, CartazItem>();
	for (const p of raw) {
		if (!p.id) {
			continue;
		}
		out.set(String(p.id), {
			id: p.id,
			slug: p.slug ?? "",
			link: p.link ?? "",
			title: decodeEntities((p.title?.rendered ?? "").trim()),
			localidade: Array.isArray(p.localidade) ? p.localidade.map(Number) : [],
			tipo: decodeEntities(
				Array.isArray(p.meta?.tipo)
					? p.meta!.tipo!.join(" ")
					: String(p.meta?.tipo ?? ""),
			),
		});
	}
	return out;
}

/** Parse a localidade term array → id → name map. */
export function parseLocalidade(text: string): Map<number, string> {
	const raw = JSON.parse(text) as Array<{ id?: number; name?: string }>;
	const out = new Map<number, string>();
	for (const t of raw) {
		if (t.id && t.name) {
			out.set(Number(t.id), decodeEntities(t.name));
		}
	}
	return out;
}

export function slugFor(item: CartazItem): string {
	return `rl-${item.slug}`;
}

function categoryFor(tipo: string): string {
	const t = tipo.toLowerCase();
	if (t.includes("festa")) {
		return "Festas";
	}
	if (t.includes("oxigenio")) {
		return "Atividades ao Ar Livre";
	}
	return "Agenda";
}

/** Build one RawEvent from a dated row + its cartaz detail + place name. */
export function toRawEvent(
	row: MonthRow,
	item: CartazItem,
	place: string,
): RawEvent {
	const clock = parseWallClock(row.date);
	let startAt: number | null = null;
	let endAt: number | null = null;
	if (clock) {
		try {
			startAt = toEpochInLisbon(clock.y, clock.m, clock.d, clock.h, clock.min);
			endAt = startAt; // single dated occurrence
		} catch {
			startAt = null;
			endAt = null;
		}
	}
	const venue = place.trim() || "Local a definir";
	return {
		title: item.title,
		slug: slugFor(item),
		description: null, // content/excerpt are empty in this CPT
		startAt,
		endAt,
		dateText: startAt != null ? null : row.date,
		venueName: venue,
		city: place.trim() || null,
		categories: [categoryFor(item.tipo)],
		imageUrl: null,
		url: item.link,
	};
}

/**
 * Scrape the Região de Leiria cartaz: monthly discovery (current + horizon)
 * → joined cartaz detail → localidade names → district gate. `isInScope`
 * defaults to the district gate and is injectable for tests.
 */
export async function scrape(
	deps: ScrapeDeps = {
		fetchText: defaultFetchText,
		sleep: defaultSleep,
		loadState: () => loadState("regiaoleiria", DEFAULT_STATE),
		saveState: (s) => saveState("regiaoleiria", s),
		now: Math.floor(Date.now() / 1000),
	},
	isInScope: (city: string | null | undefined) => boolean = (city) =>
		isLeiriaDistrict(city),
): Promise<ScrapeResult> {
	let detailRequests = 0;
	let placeRequests = 0;
	let failures = 0;
	let firstError: string | null = null;
	let pagesFetched = 0;
	let droppedOutOfDistrict = 0;

	const now = deps.now;
	const base = DateTime.fromSeconds(now, { zone: "Europe/Lisbon" });

	const fetchPage = async (url: string): Promise<string> => {
		await deps.sleep(50 + Math.floor(Math.random() * 60));
		return deps.fetchText(url);
	};

	// 1. Discovery: current + next month ALWAYS (near-term roster churns
	// daily); further horizon months fetched only when not yet watermarked.
	const state = deps.loadState();
	const watermarked = new Set(state.monthsFetched);
	const monthsToFetch: string[] = [];
	for (let off = 0; off <= HORIZON_MONTHS; off++) {
		const dt = base.plus({ months: off });
		const key = `${dt.year}-${dt.month}`;
		// off 0 (current) and off 1 (next) are always refreshed; past them we
		// trust the watermark so a settled run costs ~2 discovery calls.
		if (off <= 1 || !watermarked.has(key)) {
			monthsToFetch.push(key);
		}
	}

	const rowsByMonth: Array<{ key: string; rows: MonthRow[] }> = [];
	try {
		for (const key of monthsToFetch) {
			const [y, m] = key.split("-");
			const url = `${BY_MONTH_BASE}?month=${Number(m)}&year=${Number(y)}`;
			const text = await fetchPage(url);
			pagesFetched++;
			rowsByMonth.push({ key, rows: parseMonthRows(text) });
		}
	} catch (err) {
		return {
			events: [],
			failures,
			firstError: err instanceof Error ? err.message : String(err),
			pagesFetched,
			discovered: 0,
			droppedOutOfDistrict: 0,
		};
	}

	// Union of post ids across the fetched months, preserving rows.
	const rowsByPost = new Map<string, MonthRow[]>();
	for (const { key } of rowsByMonth) {
		watermarked.add(key);
	}
	for (const { rows } of rowsByMonth) {
		for (const r of rows) {
			const arr = rowsByPost.get(r.postId) ?? [];
			arr.push(r);
			rowsByPost.set(r.postId, arr);
		}
	}
	const discovered = rowsByPost.size;

	// 2. Fetch cartaz detail for every post id seen THIS run (bounded), so
	// steady-state runs still emit fresh events rather than nothing.
	const cartazById = new Map<string, CartazItem>();
	const detailNeeded = [...rowsByPost.keys()];
	if (detailNeeded.length > 0) {
		const chunks: string[][] = [];
		for (let i = 0; i < detailNeeded.length; i += PER_PAGE) {
			chunks.push(detailNeeded.slice(i, i + PER_PAGE));
		}
		for (const chunk of chunks) {
			if (detailRequests >= MAX_DETAIL_REQUESTS) {
				break;
			}
			detailRequests++;
			try {
				const url = `${CART_AZ_BASE}?per_page=${PER_PAGE}&include=${chunk.join(",")}&_fields=id,title,slug,link,date,localidade,meta`;
				const text = await fetchPage(url);
				pagesFetched++;
				const parsed = parseCartaz(text);
				for (const [id, item] of parsed) {
					cartazById.set(id, item);
				}
			} catch (err) {
				failures++;
				if (!firstError) {
					firstError = err instanceof Error ? err.message : String(err);
				}
				break;
			}
		}
	}

	// 3. Fetch localidade term names for every term id we will gate on.
	const termIds = new Set<number>();
	for (const item of cartazById.values()) {
		for (const t of item.localidade) {
			termIds.add(t);
		}
	}
	const terms = new Map<number, string>();
	const termList = [...termIds];
	const tChunks: number[][] = [];
	for (let i = 0; i < termList.length; i += PER_PAGE) {
		tChunks.push(termList.slice(i, i + PER_PAGE));
	}
	for (const chunk of tChunks) {
		if (placeRequests >= MAX_PLACE_REQUESTS) {
			break;
		}
		placeRequests++;
		try {
			const url = `${LOCALIDADE_BASE}?per_page=${PER_PAGE}&include=${chunk.join(",")}&_fields=id,name,slug`;
			const text = await fetchPage(url);
			pagesFetched++;
			for (const [id, name] of parseLocalidade(text)) {
				terms.set(id, name);
			}
		} catch (err) {
			failures++;
			if (!firstError) {
				firstError = err instanceof Error ? err.message : String(err);
			}
			break;
		}
	}

	// 4. Emit one RawEvent per (post_id, date), district-gated on the place.
	const events: RawEvent[] = [];
	const emitted = new Set<string>();
	const seenKeys = new Set<string>();
	for (const [postId, rows] of rowsByPost) {
		const item = cartazById.get(postId);
		if (!item) {
			continue; // detail fetch failed or capped; row silently skipped
		}
		// Place name from the first localidade term (fallback: normalize it).
		const place =
			item.localidade.length > 0
				? (terms.get(item.localidade[0] as number) ?? "")
				: "";
		for (const row of rows) {
			const key = `${postId}|${row.date}`;
			if (emitted.has(key)) {
				continue; // exactly one RawEvent per (post id, date)
			}
			if (!isInScope(place || item.title)) {
				droppedOutOfDistrict++;
				continue;
			}
			const raw = toRawEvent(row, item, place);
			// Drop already-past dates; never roll forward to invent a future.
			if (raw.startAt != null && raw.startAt < now) {
				continue;
			}
			// Never emit the same title on the same day twice.
			const dup = `${item.title}|${raw.startAt ?? row.date}`;
			if (seenKeys.has(dup)) {
				continue;
			}
			seenKeys.add(dup);
			emitted.add(key);
			events.push(raw);
		}
	}

	// 5. Persist the month watermark: these discovery months are now known, so
	//    a steady-state run skips the horizon months still in the past. The
	//    CURRENT month is always refreshed regardless (see step 1).
	deps.saveState({ monthsFetched: [...watermarked] });

	return {
		events,
		failures,
		firstError,
		pagesFetched,
		discovered,
		droppedOutOfDistrict,
	};
}
