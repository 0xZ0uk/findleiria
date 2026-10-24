/**
 * Ingest a single event from a pasted URL (SLICE_4, "paste-a-link").
 *
 * Usage: bun run src/ingest-url.ts <url> [venue-name]
 *
 * Supported hosts (v1): leiriagenda.cm-leiria.pt detail pages. Dedupes by
 * fingerprint, so re-ingesting a known URL is a no-op and manual additions
 * merge with the daily scrape instead of duplicating.
 *
 * The page is fetched through the scraper's `http.ts` (timeout, retries, and
 * a non-2xx answer is an error), so a 404 or an error page is never parsed
 * as an event.
 */
import { errorMessage } from "./scraper/errors";
import { defaultFetchText } from "./scraper/http";
import { ingest } from "./scraper/ingest";
import { parseDetail } from "./scraper/leiriagenda";
import type { RawEvent } from "./scraper/types";

const url = process.argv[2];
if (!url) {
	console.error("usage: bun run src/ingest-url.ts <url> [venue-name]");
	process.exit(1);
}

const SITE = "https://leiriagenda.cm-leiria.pt";
if (!url.startsWith(SITE)) {
	console.error(
		`unsupported host — currently only leiriagenda detail pages (${SITE}/pt/agenda/...)`,
	);
	process.exit(1);
}

let html: string;
try {
	html = await defaultFetchText(url);
} catch (err) {
	console.error("fetch failed:", errorMessage(err));
	process.exit(2);
}

let raw: RawEvent;
try {
	raw = parseDetail(html, url);
} catch (err) {
	console.error("parse failed:", errorMessage(err));
	process.exit(2);
}

const venueOverride = process.argv[3];
if (venueOverride) {
	raw = { ...raw, venueName: venueOverride };
}

const result = await ingest([raw], "manual", {
	found: 1,
	failures: 0,
	firstError: null,
});

console.log(
	JSON.stringify(
		{
			url,
			title: raw.title,
			venue: raw.venueName,
			startAt: raw.startAt ? new Date(raw.startAt * 1000).toISOString() : null,
			...result,
		},
		null,
		2,
	),
);
if (result.error) {
	process.exitCode = 1;
}
