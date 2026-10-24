/**
 * Last page number advertised by a listing's pagination links
 * (`?<param>=N` / `&<param>=N`, e.g. `page=6` or `events_list_13_page=44`).
 * Null when the markup carries no such link, so a caller can tell "one page"
 * apart from "could not read the paginator" and fall back to its own cap.
 */
export function lastPageFromHtml(html: string, param: string): number | null {
	const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const nums = [...html.matchAll(new RegExp(`[?&]${escaped}=(\\d+)`, "g"))].map(
		(m) => Number.parseInt(m[1] ?? "0", 10),
	);
	return nums.length > 0 ? Math.max(...nums) : null;
}
