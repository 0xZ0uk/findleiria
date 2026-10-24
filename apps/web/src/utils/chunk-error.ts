/**
 * A lazy chunk that failed to load. After a deploy an open tab still points at
 * the previous build's hashed file names, which no longer exist, so the dynamic
 * import rejects. The wording differs per browser; none of it is a stable code.
 */
const CHUNK_FAILURE = [
	/failed to fetch dynamically imported module/i, // Chromium
	/error loading dynamically imported module/i, // Firefox
	/importing a module script failed/i, // Safari
	/loading (css )?chunk [\w-]+ failed/i, // webpack-style
	/unable to preload css/i, // Vite's CSS preload helper
];

export function isChunkLoadError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return CHUNK_FAILURE.some((pattern) => pattern.test(message));
}
