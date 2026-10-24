/**
 * Cross-source identity rules — pure, no DB.
 *
 * Rows whose fingerprints differ can still be the same real-world event:
 * sources disagree on wall-clock time (Viral Agenda's JSON-LD is one hour
 * early during DST) and on how they WORD the title.
 *
 * Group dated rows by (normalized title, venue ref, Lisbon day) — the
 * identity key. RULE 2/3 (venue wildcard) then unions rows whose venues are
 * compatible within a group. RULE 4 (title variants) unions rows that agree
 * on the occurrence but not on the wording.
 *
 * Within a group, rows attributed to the HIGHEST-trust source are the
 * canonical session set (distinct start times are legitimate same-day
 * sessions — SLICE_6 keeps those). Lower-trust rows are merged into their
 * nearest canonical session; their categories and source attributions
 * follow. Same-tier rows are never merged into each other, unless a multi-day
 * SPAN row stands for the whole run (see spanKeeper).
 */

import { isDistrictLocality } from "./district";
import { lisbonDay } from "./fingerprint";
import {
	isVagueVenue,
	normalizeCity,
	normalizeTitle,
	slugify,
	venuesMatch,
	venueTokens,
} from "./normalize";
import { cityKey } from "./venue-city";

/** Which source to trust for TIME, most-trusted first. Manual (paste-a-link)
 * ingest is a human-vetted row; municipal/first-party agendas come next, then
 * ticketing platforms with machine-readable times, then aggregators. Viral
 * Agenda is last among known sources — its JSON-LD is DST-shifted. A row's
 * trust is the BEST source attributing it. Every key of the `sources`
 * registry (index.ts) must be listed here (guarded by a test); a source
 * missing from this list ranks below viralagenda. */
export const TIME_SOURCE_PRIORITY = [
	"manual",
	"leiriagenda",
	"municipal",
	"obidos",
	"caldas",
	"figueiro",
	"regiaoleiria",
	"cmleiriarss",
	"eventbrite",
	"ticketline",
	"shotgun",
	"bol",
	"cisterfestas",
	"festasearraiais",
	"turismodocentro",
	"nocartaz",
	"viralagenda",
] as const;

export function sourceTrust(source: string): number {
	const i = (TIME_SOURCE_PRIORITY as readonly string[]).indexOf(source);
	return i === -1 ? TIME_SOURCE_PRIORITY.length : i;
}

export interface IdentityRow {
	id: number;
	title: string;
	start_at: number;
	/** Multi-day rows (a festa's span) end here; null when unknown. */
	end_at?: number | null;
	/** All sources attributing this row (best trust wins). */
	sources: string[];
	/** `source:sourceEventId` when exactly one source item owns this row. */
	itemKey?: string | null;
}

export function rowTrust(row: IdentityRow): number {
	return row.sources.length === 0
		? TIME_SOURCE_PRIORITY.length
		: Math.min(...row.sources.map(sourceTrust));
}

/** Stable identity key: same title+venue+Lisbon-day ⇒ same real-world show. */
export function identityKey(
	title: string,
	venueRef: string,
	startAt: number,
): string {
	return `${normalizeTitle(title)}|${slugify(venueRef)}|${lisbonDay(startAt)}`;
}

export interface MergePlan {
	/** Canonical session rows (highest-trust tier), one per time cluster. */
	keepers: IdentityRow[];
	/** Non-canonical row id → canonical (keeper) row id it merges into. */
	absorbed: Map<number, number>;
	/** Keeper id → end_at the merge implies (day pages of one source item). */
	endByKeeper?: Map<number, number>;
}

/**
 * Start times within this many seconds (inclusive) are the same session.
 * Sources disagree on wall-clock by one hour (DST/format shifts), so a
 * sub-hour skew is one concert, not two. 3600s apart ⇒ ONE keeper; 5400s
 * apart (a real 10:00 + 11:30 double header) ⇒ TWO.
 */
export const SESSION_WINDOW_SECONDS = 3600;

/** A row spanning at least this long describes a RUN of days, not a session. */
export const SPAN_SECONDS = 86_400;

/** A row's occupied interval; an open-ended row occupies its whole day. */
function occupiedRange(row: {
	start_at: number;
	end_at?: number | null;
}): [number, number] {
	return [
		row.start_at,
		row.end_at != null && row.end_at > row.start_at
			? row.end_at
			: row.start_at + 86_400 - 1,
	];
}

/** True when two rows' occupied intervals share at least one instant. */
export function rangesOverlap(
	a: { start_at: number; end_at?: number | null },
	b: { start_at: number; end_at?: number | null },
): boolean {
	const [aStart, aEnd] = occupiedRange(a);
	const [bStart, bEnd] = occupiedRange(b);
	return aStart <= bEnd && bStart <= aEnd;
}

/**
 * The multi-day row that stands for a whole run (a festa spanning days).
 * When one row's interval COVERS the start of every other row in the
 * component, that row is the single keeper: the per-day rows another source
 * emitted for the same festa fold into it instead of shipping as 3-4 cards.
 * Highest trust wins when two sources both publish a span; earliest start,
 * then lowest id, break the tie. Returns undefined when no row covers the
 * rest, leaving the normal session logic in charge.
 */
export function spanKeeper(rows: IdentityRow[]): IdentityRow | undefined {
	const spans = rows.filter(
		(r) => r.end_at != null && r.end_at - r.start_at >= SPAN_SECONDS,
	);
	if (spans.length === 0) return undefined;
	const covering = spans.filter((span) =>
		rows.every(
			(r) =>
				r.id === span.id ||
				(r.start_at >= span.start_at && r.start_at <= (span.end_at ?? 0)),
		),
	);
	if (covering.length === 0) return undefined;
	return [...covering].sort(
		(a, b) =>
			rowTrust(a) - rowTrust(b) || a.start_at - b.start_at || a.id - b.id,
	)[0];
}

/** Plan the merge for one identity component. No I/O, fully deterministic. */
export function planMerge(rows: IdentityRow[]): MergePlan {
	if (rows.length === 0) return { keepers: [], absorbed: new Map() };
	// A multi-day row that covers the whole component stands for one festa:
	// the per-day cards another source emitted for the same festa fold into
	// it instead of shipping as 3-4 near-identical cards.
	const span = spanKeeper(rows);
	if (span) {
		const absorbed = new Map<number, number>();
		for (const r of rows) {
			if (r.id !== span.id) absorbed.set(r.id, span.id);
		}
		return { keepers: [span], absorbed };
	}

	const bestTrust = Math.min(...rows.map(rowTrust));

	// Every row in the component came from ONE source item (three day pages of
	// the same festa and nothing else): the source itself says this is a single
	// event, so the earliest row keeps the card and the run widens its end.
	const itemKeys = new Set(
		rows.map((r) => r.itemKey).filter((k): k is string => !!k),
	);
	if (itemKeys.size === 1 && rows.every((r) => !!r.itemKey)) {
		const keeper = [...rows].sort(
			(a, b) => a.start_at - b.start_at || a.id - b.id,
		)[0] as IdentityRow;
		const absorbed = new Map<number, number>();
		let end = keeper.end_at ?? keeper.start_at;
		for (const r of rows) {
			end = Math.max(end, r.end_at ?? r.start_at);
			if (r.id !== keeper.id) absorbed.set(r.id, keeper.id);
		}
		return {
			keepers: [keeper],
			absorbed,
			endByKeeper: new Map([[keeper.id, end]]),
		};
	}
	const canonical = rows.filter((r) => rowTrust(r) === bestTrust);
	// One keeper per CLUSTER of starts within SESSION_WINDOW_SECONDS, walked
	// sorted by start then id. A cluster's earliest row is its keeper: a
	// DST-shifted twin (3600s off) coalesces into the cross-source keeper
	// instead of minting a fake second session, while a genuine double
	// header (>3600s apart) still yields two keepers. Its own time is kept.
	const keepers: IdentityRow[] = [];
	let clusterStart: number | null = null;
	for (const r of [...canonical].sort(
		(a, b) => a.start_at - b.start_at || a.id - b.id,
	)) {
		if (
			clusterStart === null ||
			r.start_at - clusterStart > SESSION_WINDOW_SECONDS
		) {
			clusterStart = r.start_at;
			keepers.push(r);
		}
	}
	const titleVariants = new Set(rows.map((r) => normalizeTitle(r.title)));
	if (titleVariants.size > 1) {
		// Different wording for one occurrence (RULE 4 fused them): the card is
		// the best-attributed row, whatever the other sources' wall-clock says.
		// Viral Agenda ships the same festival twice with a DST-shifted time and
		// a subtitle — keeping both times would ship two cards for one event.
		const keeper = [...rows].sort(
			(a, b) =>
				rowTrust(a) - rowTrust(b) || a.start_at - b.start_at || a.id - b.id,
		)[0] as IdentityRow;
		const absorbed = new Map<number, number>();
		for (const r of rows) {
			if (r.id !== keeper.id) absorbed.set(r.id, keeper.id);
		}
		return { keepers: [keeper], absorbed };
	}

	const absorbed = new Map<number, number>();
	for (const r of rows) {
		if (keepers.some((k) => k.id === r.id)) continue;
		let best: IdentityRow | undefined;
		let bestDelta = Number.POSITIVE_INFINITY;
		for (const k of keepers) {
			const delta = Math.abs(k.start_at - r.start_at);
			if (delta < bestDelta) {
				bestDelta = delta;
				best = k;
			}
		}
		if (best) {
			absorbed.set(r.id, best.id);
		}
	}
	return { keepers, absorbed };
}

/**
 * Component grouping (RULE 2 + RULE 3): rows that differ ONLY by how a
 * source names the venue (or name the venue vaguely) can still be the same
 * real-world show. Group dated rows by (normalized title, Lisbon day), then
 * union rows whose venues are COMPATIBLE within each group. Distinct title
 * or distinct day is a hard boundary here — RULE 4 handles the title.
 */

/** Group key for event identity: normalized title + Lisbon day. */
export function dayIdentityKey(title: string, startAt: number): string {
	return `${normalizeTitle(title)}|${lisbonDay(startAt)}`;
}

export interface ComponentRow {
	id: number;
	title: string;
	start_at: number;
	/** Multi-day rows (a festa's span) end here; null when unknown. */
	end_at?: number | null;
	venue: string | null;
	city: string | null;
	/** `source:sourceEventId` when exactly one source item owns this row. */
	itemKey?: string | null;
}

/**
 * Venue compatibility for EVENT identity (the wildcard). Vague/placeholder
 * venues are city-level announcements: two vague venues match regardless of
 * the venue name (within one town, or when a town is unknown — C3), and a
 * vague venue matches a specific venue when both rows
 * are in the same city. Two specific venues only match under the STRICT
 * `venuesMatch`. This is intentionally LOSER than `venuesMatch` — it lets
 * duplicate EVENT rows fuse — but it must NEVER be used to merge venue ROWS
 * (a vague "Leiria (cidade)" row treated as a hub would collapse every
 * Leiria venue into one). Venue-row merging stays strictly `venuesMatch`.
 *
 * `aStart`/`bStart` (optional) unlock one further wildcard for the case where
 * two rows agree on the event but not on the CITY string: a concelho-level
 * placeholder ("Marinha Grande" as the municipal agenda's venue) against a
 * specific venue whose city is a parish of that same concelho ("Ordem",
 * "São Pedro de Moel"). Accepted only for a NON-municipality locality AND the
 * same session (≤ SESSION_WINDOW_SECONDS), so it cannot fuse a same-titled
 * same-day event across concelhos.
 */
export function venueCompatible(
	aVenue: string | null,
	bVenue: string | null,
	aCity: string | null,
	bCity: string | null,
	aStart: number | null = null,
	bStart: number | null = null,
): boolean {
	// No venue either side: only an exact match groups (mirrors the old
	// empty-venue identity key — never cross-wire an unlocated roster to a
	// specific venue).
	if (aVenue == null || bVenue == null) return aVenue === bVenue;
	const aVague = isVagueVenue(aVenue, aCity);
	const bVague = isVagueVenue(bVenue, bCity);
	// Two placeholders match whatever their names — but not across towns: a
	// generic "Vários Espaços Culturais" in Batalha and in Pombal are two
	// announcements (C3). An unknown town matches either.
	if (aVague && bVague) {
		const aTown = cityKey(aCity);
		const bTown = cityKey(bCity);
		return aTown === "" || bTown === "" || aTown === bTown;
	}
	if (aVague || bVague) {
		if (normalizeCity(aCity ?? "") === normalizeCity(bCity ?? "")) return true;
		const specificCity = aVague ? bCity : aCity;
		return (
			isDistrictLocality(specificCity) &&
			aStart !== null &&
			bStart !== null &&
			Math.abs(aStart - bStart) <= SESSION_WINDOW_SECONDS
		);
	}
	return venuesMatch(aVenue, bVenue, aCity, bCity);
}

/**
 * RULE 4 — title variants of ONE occurrence.
 *
 * dayIdentityKey demands an IDENTICAL normalized title, so a source that
 * appends an edition year or the locality it plays in
 * ("Festa em honra de São Silvestre 2026 - Mato Velho" vs
 * "Festas de São Silvestre") escapes the venue wildcard and the same festa
 * ships twice. Two rows fuse when ALL of these hold:
 *
 *   1. their occupied intervals overlap (adjacent single-day rows do NOT:
 *      separate occurrences stay separate cards);
 *   2. one title's CORE tokens are a subset of the other's — core = normalized
 *      words minus function words, event-type nouns, liturgical filler,
 *      edition words and pure digits — so the twin differs only by noise;
 *   3. they agree on the place: venueCompatible, the same normalized city, or
 *      at least one shared discriminating venue token;
 *   4. the longer title only ADDS words the other row ALREADY names in its own
 *      venue (the locality/parish that source left out of the title, or the
 *      concelho of a vague placeholder). Anything else names something extra
 *      — a sub-event ("Neon Run - Festival Viver São Bento") — and keeps its
 *      own card. When neither title adds anything (same core), the venues
 *      themselves must agree.
 */

/** Function words, event-type nouns and liturgical/edition filler that say
 * nothing about WHICH event a title names. Dropped before comparing. */
export const TITLE_NOISE = new Set([
	"de",
	"da",
	"do",
	"das",
	"dos",
	"e",
	"em",
	"no",
	"na",
	"o",
	"a",
	"os",
	"as",
	"ao",
	"aos",
	"para",
	"com",
	"por",
	"sobre",
	"ate",
	"um",
	"uma",
	"uns",
	"umas",
	"the",
	"of",
	"and",
	"festa",
	"festas",
	"festival",
	"festivais",
	"feira",
	"feiras",
	"romaria",
	"romarias",
	"arraial",
	"arraiais",
	"evento",
	"eventos",
	"programa",
	"programacao",
	"edicao",
	"edicoes",
	"honra",
	"memoria",
	"comemoracao",
	"comemoracoes",
	"celebracao",
	"celebracoes",
	"realizacao",
	"ano",
	"anos",
	"dia",
	"dias",
	"mes",
	"meses",
	"noite",
	"noites",
]);

/** Ordered unique significant tokens of a title (see TITLE_NOISE). */
export function titleCoreTokens(title: string): string[] {
	const out: string[] = [];
	for (const w of normalizeTitle(title).split(" ")) {
		if (w.length === 0) continue;
		if (TITLE_NOISE.has(w)) continue;
		if (/^\d+$/.test(w)) continue;
		if (!out.includes(w)) out.push(w);
	}
	return out;
}

/** Precomputed per-row facts for the RULE 4 pass. */
export interface TitleVariantFacts {
	dayKey: string;
	core: string[];
	/** Discriminating venue tokens (city stripped) — the row's own places. */
	venue: string[];
	/** City tokens, used when the venue is a vague concelho placeholder. */
	city: string[];
	place: Set<string>;
	vagueVenue: boolean;
}

export function titleVariantFacts(row: ComponentRow): TitleVariantFacts {
	const venue = venueTokens(row.venue ?? "", row.city);
	const city = normalizeCity(row.city)
		.split(" ")
		.filter((t) => t.length > 0);
	const place = new Set<string>([...venue, ...city]);
	return {
		dayKey: dayIdentityKey(row.title, row.start_at),
		core: titleCoreTokens(row.title),
		venue,
		city,
		place,
		vagueVenue: isVagueVenue(row.venue ?? "", row.city),
	};
}

/** True when the two rows are one occurrence written two ways (RULE 4). */
export function sameOccurrenceVariant(
	a: ComponentRow,
	aFacts: TitleVariantFacts,
	b: ComponentRow,
	bFacts: TitleVariantFacts,
): boolean {
	// Same Lisbon day, same wording: pass 1 owns those. A DIFFERENT wording on
	// the same day is still RULE 4's — pass 1 groups by (title, day), so a
	// span row and a day row that start the same day never meet there. That
	// gap shipped a festa's span card next to three per-day cards.
	if (
		aFacts.dayKey === bFacts.dayKey &&
		normalizeTitle(a.title) === normalizeTitle(b.title)
	) {
		return false;
	}
	if (!rangesOverlap(a, b)) return false;

	const aShorter = aFacts.core.length <= bFacts.core.length;
	const shortF = aShorter ? aFacts : bFacts;
	const longF = aShorter ? bFacts : aFacts;
	if (shortF.core.length === 0) return false;
	if (!shortF.core.every((t) => longF.core.includes(t))) return false;

	const sameCity =
		normalizeCity(a.city) !== "" &&
		normalizeCity(a.city) === normalizeCity(b.city);
	// One row's venue tokens may all live in the other row's PLACES: a venue
	// named after its own village strips to no venue tokens at all
	// ("Bidoeira de Cima" in city "Bidoeira de Cima"), so the comparison has
	// to fall back to the other row's venue+city tokens.
	const namedInOther =
		(aFacts.venue.length > 0 &&
			aFacts.venue.every((t) => bFacts.place.has(t))) ||
		(bFacts.venue.length > 0 && bFacts.venue.every((t) => aFacts.place.has(t)));
	const venueLevel =
		venuesMatch(a.venue ?? "", b.venue ?? "", a.city, b.city) ||
		namedInOther ||
		aFacts.venue.some((t) => bFacts.venue.includes(t));
	if (
		!venueLevel &&
		!sameCity &&
		!venueCompatible(a.venue, b.venue, a.city, b.city, a.start_at, b.start_at)
	) {
		return false;
	}

	// The longer title may only add places the OTHER row already names in its
	// own venue — or in its city, which is all a village-named venue leaves.
	const added = longF.core.filter((t) => !shortF.core.includes(t));
	const allowed = new Set<string>(shortF.venue);
	if (shortF.venue.length === 0 || shortF.vagueVenue) {
		for (const t of shortF.city) allowed.add(t);
	}
	if (added.length === 0) return venueLevel;
	return added.every((t) => allowed.has(t));
}

/**
 * Split dated rows into components of the same real-world event: group by
 * (normalized title, Lisbon day), union-find on venue-compatible venues
 * (RULE 2/3), then union title variants of one occurrence (RULE 4). Returns
 * the components as arrays of rows; the caller runs `planMerge` once per
 * component.
 */
export function planComponents<T extends ComponentRow>(rows: T[]): T[][] {
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		const p = parent.get(x);
		if (p === undefined || p === x) {
			if (p === undefined) parent.set(x, x);
			return x;
		}
		const root = find(p);
		parent.set(x, root);
		return root;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(rb, ra);
	};

	for (const r of rows) find(r.id);

	// Pass 1 — same (title, day), venue-compatible venues.
	const byDay = new Map<string, T[]>();
	const factsById = new Map<number, TitleVariantFacts>();
	for (const r of rows) {
		const f = titleVariantFacts(r);
		factsById.set(r.id, f);
		const list = byDay.get(f.dayKey) ?? [];
		list.push(r);
		byDay.set(f.dayKey, list);
	}
	for (const group of byDay.values()) {
		for (const a of group) {
			for (const b of group) {
				if (a.id >= b.id) continue;
				if (
					venueCompatible(
						a.venue,
						b.venue,
						a.city,
						b.city,
						a.start_at,
						b.start_at,
					)
				) {
					union(a.id, b.id);
				}
			}
		}
	}

	// Pass 2 — RULE 4: same occurrence, different wording.
	for (let i = 0; i < rows.length; i++) {
		const a = rows[i];
		if (a === undefined) continue;
		const aFacts = factsById.get(a.id);
		if (aFacts === undefined) continue;
		for (let j = i + 1; j < rows.length; j++) {
			const b = rows[j];
			if (b === undefined) continue;
			if (find(a.id) === find(b.id)) continue;
			const bFacts = factsById.get(b.id);
			if (bFacts === undefined) continue;
			if (sameOccurrenceVariant(a, aFacts, b, bFacts)) union(a.id, b.id);
		}
	}

	// Pass 3 — one source item published once per day (a festa's day pages,
	// regiaoleiria-style). The source's own item id is the strongest identity
	// signal available: those rows are one event whatever the day or wording.
	const byItem = new Map<string, T[]>();
	for (const r of rows) {
		const key = r.itemKey;
		if (!key) continue;
		const list = byItem.get(key) ?? [];
		list.push(r);
		byItem.set(key, list);
	}
	for (const group of byItem.values()) {
		const first = group[0];
		if (first === undefined) continue;
		for (const r of group) union(first.id, r.id);
	}

	const byRoot = new Map<number, T[]>();
	for (const r of rows) {
		const root = find(r.id);
		const list = byRoot.get(root) ?? [];
		list.push(r);
		byRoot.set(root, list);
	}
	return [...byRoot.values()];
}
