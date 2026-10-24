/**
 * Message from an unknown thrown value.
 *
 * Scrapers throw `Error`, plain strings and fetch failures, and the runner has
 * to put readable text into the `scrape_runs` row it writes when a source
 * blows up — `String(err)` on an Error gives "Error: ..." with a stack-free
 * prefix and loses nothing, but `JSON.stringify` is needed for odd payloads.
 */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		// drizzle wraps driver errors as "Failed query: <sql> params: …"; the
		// driver's own message (the cause) is the part worth recording.
		if (err.message.startsWith("Failed query:") && err.cause instanceof Error) {
			return err.cause.message;
		}
		return err.message;
	}
	if (typeof err === "string") {
		return err;
	}
	try {
		const json = JSON.stringify(err);
		return json ?? String(err);
	} catch {
		return String(err);
	}
}
