/**
 * Retry cap for pages that never parse.
 *
 * A fetched page with no title, date or JSON-LD is not marked seen (a parser
 * fix should pick it up), so it used to be re-fetched on EVERY run and ate the
 * per-run request cap forever. Sources keep `attempts: { [url]: failedParses }`
 * in their state file; after `MAX_PARSE_ATTEMPTS` failed parses the url is
 * given up on: marked seen as unparseable, reported once, never fetched again.
 *
 * The map is optional in the state file, so state written before this existed
 * loads unchanged (no attempts recorded yet).
 */

export const MAX_PARSE_ATTEMPTS = 3;

export type ParseAttempts = Record<string, number>;

export interface ParseAttempt {
	/** Failed parses of this url, this one included. */
	count: number;
	/** True once the cap is reached: stop retrying this url. */
	exhausted: boolean;
}

/**
 * Count one more failed parse of `url`. Pure: the caller decides when to
 * persist `pending` (after ingest, C7).
 */
export function recordParseFailure(
	previous: ParseAttempts | undefined,
	pending: ParseAttempts,
	url: string,
): ParseAttempt {
	const count = (pending[url] ?? previous?.[url] ?? 0) + 1;
	pending[url] = count;
	return { count, exhausted: count >= MAX_PARSE_ATTEMPTS };
}

/**
 * The attempts to persist: previous ones, updated by this run's `pending`,
 * minus urls that resolved (parsed, or given up on and so now in `seen`).
 */
export function mergeAttempts(
	previous: ParseAttempts | undefined,
	pending: ParseAttempts,
	resolved: Iterable<string>,
): ParseAttempts {
	const merged: ParseAttempts = { ...previous, ...pending };
	for (const url of resolved) delete merged[url];
	return merged;
}

/** The message for the one failure reported when a url is given up on. */
export function giveUpMessage(url: string): string {
	return `unparseable after ${MAX_PARSE_ATTEMPTS} attempts, not retrying: ${url}`;
}
