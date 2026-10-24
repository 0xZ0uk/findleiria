/**
 * The browser half of the saved-events API.
 *
 * All writes land on `/api/saved`, a same-origin route of the Worker, which alone
 * holds the auth database (a D1 binding). The browser sends/reads the session cookie
 * with `credentials: "include"` and nothing else — no token ever ships to the
 * client. A non-OK response throws an `ApiError` carrying the HTTP status so
 * the hook can tell a dead session (401) from a broken request.
 */

/** Enriched fetch error: the status lets the caller decide what a failure means. */
export class ApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** GET /api/saved → the slugs the reader saved, newest first. */
export async function listSaved(): Promise<string[]> {
	const response = await fetch("/api/saved", { credentials: "include" });
	if (!response.ok) {
		throw new ApiError(response.status, "não foi possível ler os guardados");
	}
	const body = (await response.json()) as { slugs?: string[] };
	return body.slugs ?? [];
}

/** POST /api/saved — save or unsave one event by its slug. */
export async function setSaved(slug: string, saved: boolean): Promise<void> {
	const response = await fetch("/api/saved", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ slug, saved }),
	});
	if (!response.ok) {
		throw new ApiError(response.status, "não foi possível guardar o evento");
	}
}
