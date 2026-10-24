/**
 * Formatting + Lisbon-local date maths for the agenda.
 *
 * Every visible date and clock on the page goes through here, and every one of
 * them is pinned to Europe/Lisbon — the scraper's fingerprint pipeline groups
 * events by Lisbon day, so the UI must agree with it or a 00:30 show lands on
 * the wrong day.
 *
 * Day keys are `YYYY-MM-DD` strings: comparing them lexically is the same as
 * comparing days, which keeps range filtering free of timezone edge cases.
 */

import { lisbonDayKey } from "@events-tracker/api/grouping";

const LISBON = "Europe/Lisbon";

type Parts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
	timeZone: LISBON,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

const clockFormatter = new Intl.DateTimeFormat("pt-PT", {
	timeZone: LISBON,
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

const weekdayFormatter = new Intl.DateTimeFormat("pt-PT", {
	timeZone: LISBON,
	weekday: "long",
});

const dayMonthFormatter = new Intl.DateTimeFormat("pt-PT", {
	timeZone: LISBON,
	day: "numeric",
	month: "long",
});

const shortDayFormatter = new Intl.DateTimeFormat("pt-PT", {
	timeZone: LISBON,
	day: "2-digit",
	month: "2-digit",
});

const toDate = (epochSeconds: number) => new Date(epochSeconds * 1000);

/** Lisbon wall-clock parts of an instant. */
function lisbonParts(instantMs: number): Parts {
	const raw: Record<string, string> = {};
	for (const part of partsFormatter.formatToParts(new Date(instantMs))) {
		raw[part.type] = part.value;
	}
	return {
		year: Number(raw.year),
		month: Number(raw.month),
		day: Number(raw.day),
		hour: Number(raw.hour),
		minute: Number(raw.minute),
		second: Number(raw.second),
	};
}

/** `YYYY-MM-DD` for the Lisbon day an instant falls on. */
export const dayKey = lisbonDayKey;

/** Shift a day key by whole days, without touching the clock. */
export function shiftDayKey(key: string, days: number): string {
	const [y, m, d] = key.split("-").map(Number);
	const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
	const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const day = String(shifted.getUTCDate()).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** Offset of Europe/Lisbon at an instant, in milliseconds. */
function lisbonOffsetMs(instantMs: number): number {
	const p = lisbonParts(instantMs);
	const asIfUtc = Date.UTC(
		p.year,
		p.month - 1,
		p.day,
		p.hour % 24,
		p.minute,
		p.second,
	);
	return asIfUtc - instantMs;
}

/**
 * Epoch seconds of 00:00 Lisbon today.
 *
 * The agenda floor: a show at 00:30 stays visible until its own day is over,
 * which a UTC midnight floor would break.
 */
export function startOfLisbonDay(nowMs: number = Date.now()): number {
	const [y, m, d] = dayKey(Math.floor(nowMs / 1000))
		.split("-")
		.map(Number);
	const midnightUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
	return Math.floor((midnightUtc - lisbonOffsetMs(midnightUtc)) / 1000);
}

/**
 * Epoch seconds of the next 00:00 Lisbon, strictly after `nowMs`.
 *
 * Aims at the middle of tomorrow (36h past today's midnight; a DST day is 23
 * or 25h, so that is still tomorrow) and takes that day's start, which keeps
 * the answer right across a clock change.
 */
export function nextLisbonMidnight(nowMs: number = Date.now()): number {
	const today = startOfLisbonDay(nowMs);
	return startOfLisbonDay((today + 36 * 3600) * 1000);
}

/** `19:30` */
export function clock(epochSeconds: number): string {
	return clockFormatter.format(toDate(epochSeconds));
}

/** `sexta-feira` → `Sexta-feira` */
export function weekday(epochSeconds: number): string {
	const name = weekdayFormatter.format(toDate(epochSeconds));
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `11 de setembro` */
export function dayMonth(epochSeconds: number): string {
	return dayMonthFormatter.format(toDate(epochSeconds));
}

/** `13/09` */
export function shortDay(epochSeconds: number): string {
	return shortDayFormatter.format(toDate(epochSeconds));
}

/**
 * False when the source published no time at all.
 *
 * The scraper falls back to midnight for a date-only listing, so a `00:00`
 * clock on this page would be an invention — 37 of 237 rows in the current
 * window would claim it. Those rows show a dash instead.
 */
export function hasClock(epochSeconds: number): boolean {
	const parts = lisbonParts(epochSeconds * 1000);
	return !(parts.hour % 24 === 0 && parts.minute === 0);
}

/**
 * How the last collection reads: `hoje, 21:40`, `ontem, 07:00`, `9 set, 07:00`.
 * The old page claimed "atualizado diariamente · 07:00" instead of looking.
 */
export function lastRunLabel(
	epochSeconds: number,
	nowMs: number = Date.now(),
): string {
	const today = dayKey(Math.floor(nowMs / 1000));
	const yesterday = dayKey(Math.floor((nowMs - 86_400_000) / 1000));
	const key = dayKey(epochSeconds);

	if (key === today) return `hoje, ${clock(epochSeconds)}`;
	if (key === yesterday) return `ontem, ${clock(epochSeconds)}`;
	return `${shortDay(epochSeconds)}, ${clock(epochSeconds)}`;
}

export function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}
