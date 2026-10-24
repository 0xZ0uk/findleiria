/**
 * Politeness timing shared by every source: the real sleep and the jittered
 * pause between requests. Sources keep their own injectable `sleep` dep (the
 * offline tests replace it); these are only the production defaults.
 */

export const defaultSleep = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Jittered delay in ms: `base` plus a uniform integer in `[0, spread)`, i.e.
 * the result lies in `[base, base + spread - 1]`.
 */
export function randomDelay(base = 350, spread = 300): number {
	return base + Math.floor(Math.random() * spread);
}
