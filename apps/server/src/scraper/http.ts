export const FETCH_TIMEOUT_MS = 15000;
export const FETCH_RETRIES = 2;
export const RETRY_BACKOFF_MS = 800;

/** Backoff before a 429 retry, ms (attempt N gets N× this) when the server gave no Retry-After. */
export const RATE_LIMIT_BACKOFF_MS = 4000;

/** Upper bound on a server-supplied Retry-After wait, ms. */
export const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Fallback fetch via curl. Bun's fetch (uWebSockets-based) hard-fails with
 * `Malformed_HTTP_Response` on hosts that emit malformed header values
 * (Ticketline: "Unexpected whitespace after header value"). curl is lenient
 * and handles those fine, so on a non-HTTP-status fetch error we retry once
 * through the shell before giving up.
 */
async function curlFetchText(url: string): Promise<string> {
	const proc = Bun.spawnSync([
		"curl",
		"-sL",
		// Non-2xx (e.g. a 5xx error page) must fail, not be returned as content.
		"--fail",
		"--max-time",
		String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
		"-A",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
		url,
	]);
	const out = proc.stdout.toString();
	if (proc.exitCode !== 0 || out.length === 0) {
		throw new Error(
			`curl fallback failed for ${url}: exit ${proc.exitCode}, ${proc.stderr.toString().slice(0, 120)}`,
		);
	}
	return out;
}

/** Whether an error is Bun's malformed-response fetch failure. */
function isMalformedResponse(err: unknown): boolean {
	return (
		err instanceof Error && err.message.includes("Malformed_HTTP_Response")
	);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP date) to ms, capped at
 * MAX_RETRY_AFTER_MS. Null when absent or unparseable.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number = Date.now(),
): number | null {
	if (!value) return null;
	const v = value.trim();
	let ms: number;
	if (/^\d+(\.\d+)?$/.test(v)) {
		ms = Number(v) * 1000;
	} else {
		const at = Date.parse(v);
		if (Number.isNaN(at)) return null;
		ms = at - now;
	}
	return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Injectable collaborators so the retry policy is testable offline. */
export interface FetchTextDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	curl: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
}

const realDeps: FetchTextDeps = {
	fetch: (url, init) => fetch(url, init),
	curl: curlFetchText,
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Fetch with a hard timeout and bounded retries (FETCH_RETRIES + 1 attempts
 * in total). This module OWNS retries: callers must not wrap it in their own
 * retry loop. Retry policy:
 * - network errors / timeouts / body-read errors / 5xx: retried with linear
 *   backoff
 * - 408 (request timeout): retried like a 5xx
 * - 429 (rate limit): retried after the server's Retry-After (capped at
 *   MAX_RETRY_AFTER_MS) or, when absent, a LONG backoff (cooldown), because
 *   sources like Eventbrite/Shotgun throttle aggressively and a short
 *   retry just burns the attempt budget
 * - other 4xx: terminal (no retry)
 */
export async function fetchTextWith(
	url: string,
	deps: FetchTextDeps,
): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
		if (attempt > 0) {
			let backoff = RETRY_BACKOFF_MS * attempt;
			if (isRateLimited(lastError)) {
				const retryAfter = (lastError as { retryAfterMs?: number | null })
					.retryAfterMs;
				backoff =
					retryAfter != null ? retryAfter : RATE_LIMIT_BACKOFF_MS * attempt;
			}
			await deps.sleep(backoff);
		}
		try {
			const res = await deps.fetch(url, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: {
					"User-Agent":
						"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml",
				},
			});
			if (!res.ok) {
				const err = new Error(`GET ${url} -> HTTP ${res.status}`);
				if (res.status === 429) {
					throw Object.assign(err, {
						retryable: true,
						rateLimited: true,
						retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
					});
				}
				if (res.status < 500 && res.status !== 408) {
					throw Object.assign(err, { retryable: false });
				}
				throw Object.assign(err, { retryable: true });
			}
			// `await` so body-read failures are caught here and retried.
			return await res.text();
		} catch (err) {
			// Bun fetch cannot parse some hosts' malformed response headers
			// (e.g. Ticketline). curl is lenient — use it once as a fallback
			// before the retry/backoff machinery.
			if (isMalformedResponse(err)) {
				try {
					return await deps.curl(url);
				} catch (curlErr) {
					lastError = curlErr;
					continue;
				}
			}
			lastError = err;
			if (
				err &&
				typeof err === "object" &&
				"retryable" in err &&
				err.retryable === false
			) {
				throw err;
			}
		}
	}
	throw lastError;
}

export function defaultFetchText(url: string): Promise<string> {
	return fetchTextWith(url, realDeps);
}

export function isRateLimited(err: unknown): boolean {
	return (
		err != null &&
		typeof err === "object" &&
		"rateLimited" in err &&
		(err as { rateLimited?: boolean }).rateLimited === true
	);
}
