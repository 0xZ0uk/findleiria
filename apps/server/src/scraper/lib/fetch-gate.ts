/**
 * Serial fetch gate: every request goes through one promise chain, so the
 * request counter, the polite delay and the fetch are mutually exclusive even
 * with several concurrent workers. That keeps the request cap exact and the
 * pacing real (workers cannot burst).
 */

export interface FetchGateOptions {
	fetchText: (url: string) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	/** Hard cap on requests per gate; the next call rejects once it is hit. */
	maxRequests: number;
	/** Milliseconds to pause before each request. */
	delay: () => number;
}

export interface FetchGate {
	/** Queue a GET. Rejects with the fetch error, or when the cap is reached. */
	fetchPage: (url: string) => Promise<string>;
	/** Requests started so far (a rejected fetch still counts). */
	requests: () => number;
	/** True once `fetchPage` would refuse further requests. */
	capReached: () => boolean;
}

export function createFetchGate(opts: FetchGateOptions): FetchGate {
	let requests = 0;
	let chain: Promise<unknown> = Promise.resolve();
	const fetchPage = (url: string): Promise<string> => {
		const next = chain.then(async () => {
			if (requests >= opts.maxRequests) {
				throw new Error(`request cap ${opts.maxRequests} reached`);
			}
			requests++;
			await opts.sleep(opts.delay());
			return opts.fetchText(url);
		});
		// Swallow to keep the chain alive for queued callers; their own await
		// still sees the original error.
		chain = next.catch(() => {});
		return next;
	};
	return {
		fetchPage,
		requests: () => requests,
		capReached: () => requests >= opts.maxRequests,
	};
}
