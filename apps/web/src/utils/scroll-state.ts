/**
 * Scroll position carried in `history.state`, next to the `{from}` the event
 * page reads. Saved on the entry being left, read when popstate brings it back.
 */

/** The saved `scrollY` of a history state, or null when there is none. */
export function scrollOf(state: unknown): number | null {
	if (typeof state !== "object" || state === null) return null;
	const y = (state as { scrollY?: unknown }).scrollY;
	return typeof y === "number" && Number.isFinite(y) && y >= 0 ? y : null;
}

/** `state` with `scrollY` set, every other key (e.g. `from`) preserved. */
export function withScroll(state: unknown, scrollY: number): object {
	const base = typeof state === "object" && state !== null ? state : {};
	return { ...base, scrollY: Math.max(0, Math.round(scrollY)) };
}
