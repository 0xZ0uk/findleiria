/**
 * Backfill coordinates for venues that have none — and mark what each record
 * actually is while we are here.
 *
 *   bun run src/scraper/geocode.ts                 → write
 *   bun run src/scraper/geocode.ts --dry-run       → report, touch nothing
 *   bun run src/scraper/geocode.ts --verify        → re-check the coordinates
 *                                                    already in the database
 *   bun run src/scraper/geocode.ts --limit=20      → first 20
 *   bun run src/scraper/geocode.ts --only="Vieira" → only venues matching text
 *   bun run src/scraper/geocode.ts --report=/tmp/x → where the JSON report goes
 *
 * The first version of this script took Nominatim's first answer and trusted
 * it. That is how "Auditório Municipal de Vila Nova de Gaia", filed by a source
 * under `city = Leiria`, would be pinned in Gaia, 180 km away, and how
 * "Auditório Paroquial" would be pinned in whatever parish Nominatim liked
 * best. Every candidate here now has to land *inside* the concelho the venue's
 * own city belongs to, tested against the same district outlines the map
 * draws. A coordinate that cannot be placed in the right concelho is not
 * written, and the venue stays unmapped — which is honest, and visible.
 *
 * Records whose name is a município ("Óbidos", 113 events) are not geocoded at
 * all: they are areas, not buildings, and a pin in the middle of Óbidos would
 * claim a venue that does not exist. `scopeOfName` decides, and the scope is
 * written with the coordinates in one pass so the two can never disagree.
 *
 * One request per second, as Nominatim asks. Re-running is free: only venues
 * with a null `lat` are considered.
 */
import { readFileSync } from "node:fs";
import {
	boundsOf,
	boundsOfAll,
	concelhoAt,
	type Shape,
} from "@events-tracker/api/geo";
import { municipalityOf, scopeOfName } from "@events-tracker/api/places";
import { db, schema } from "@events-tracker/db";
import { eq, isNotNull, isNull } from "drizzle-orm";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "findleiria/0.1 (pedro@porta443.com)";
const MIN_DELAY_MS = 1100; // Nominatim policy: max 1 req/sec
const TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 250;

/**
 * The district outlines the map draws. They live in the web app because that is
 * where they are rendered; this script only reads them, and reading them by
 * path beats keeping a second copy of 100 KB of geometry that can drift.
 */
const SHAPES = JSON.parse(
	readFileSync(
		new URL("../../../../apps/web/src/assets/concelhos.json", import.meta.url),
		"utf8",
	),
).features as Shape[];

/** OSM classes that mean "a settlement", not "a building you can enter". */
const PLACE_CLASSES = new Set([
	"hamlet",
	"isolated_dwelling",
	"locality",
	"neighbourhood",
	"quarter",
	"suburb",
	"town",
	"village",
]);

type NominatimHit = {
	lat: string;
	lon: string;
	display_name: string;
	class?: string;
	type?: string;
};

type Status = "ok" | "lugar" | "outside" | "no-hit" | "skipped" | "bad-coords";

type Outcome = {
	id: number;
	name: string;
	city: string | null;
	status: Status;
	scope: "venue" | "lugar" | "concelho";
	variant?: string;
	concelho?: string | null;
	lat?: number;
	lng?: number;
	address?: string;
	note?: string;
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limit =
	Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) ||
	DEFAULT_LIMIT;
const reportPath =
	args.find((a) => a.startsWith("--report="))?.split("=")[1] ??
	"/tmp/venue-geocode-report.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(
	query: string,
	viewbox?: [number, number, number, number],
): Promise<NominatimHit[]> {
	// Nominatim wants viewbox as left,top,right,bottom — lng/lat, north first.
	const box = viewbox
		? `&viewbox=${viewbox[0]},${viewbox[3]},${viewbox[2]},${viewbox[1]}&bounded=1`
		: "";
	const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=3&countrycodes=pt&addressdetails=0${box}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, "Accept-Language": "pt" },
			signal: controller.signal,
		});
		if (!res.ok) {
			console.error(`  HTTP ${res.status} for "${query}"`);
			return [];
		}
		return (await res.json()) as NominatimHit[];
	} catch (err) {
		console.error(`  request failed for "${query}": ${(err as Error).message}`);
		return [];
	} finally {
		clearTimeout(timer);
	}
}

const byName = new Map(SHAPES.map((shape) => [shape.properties.name, shape]));
const districtBox = boundsOfAll(SHAPES);

/**
 * `--verify` is the check without the writing: every coordinate the database
 * already holds, re-tested against the concelho its own city belongs to, no
 * network and no changes. A backfill is only as good as the next time someone
 * distrusts it, and this is how they find out in one command.
 */
if (args.includes("--verify")) {
	const placed = await db.query.venues.findMany({
		where: isNotNull(schema.venues.lat),
	});
	let wrong = 0;
	for (const venue of placed) {
		const concelho = concelhoAt(venue.lng ?? 0, venue.lat ?? 0, SHAPES);
		const expected = municipalityOf(venue.city);
		const ok = expected ? concelho === expected : concelho !== null;
		if (!ok) {
			wrong += 1;
			console.log(
				`  MISMATCH ${venue.name} — city ${venue.city} (${expected ?? "no município"}), point lands in ${concelho ?? "no concelho"}`,
			);
		}
	}
	console.log(
		`\n${placed.length} venues carry coordinates, ${wrong} outside their own concelho.`,
	);
	process.exit(wrong === 0 ? 0 : 1);
}

const pendingAll = await db.query.venues.findMany({
	where: isNull(schema.venues.lat),
	orderBy: (venues, { desc }) => [desc(venues.id)],
});
// Newest first, on purpose. The corpus grows at the edge — today's sources bring
// today's venues — while the venues that never resolve (a source's own
// "VÁRIOS LOCAIS", a club OSM has never heard of) never leave the queue at all.
// Oldest-first would spend the daily budget on the names that will never be
// placed and let the new ones wait behind them.

/**
 * `--only=<text>` is for the second look: one venue the gate refused because
 * the source filed it under the wrong município, a name that has since been
 * corrected. Without it, retrying that one venue means walking every venue
 * still waiting — one Nominatim request per second, for hours.
 */
const only = args
	.find((a) => a.startsWith("--only="))
	?.split("=")
	.slice(1)
	.join("=")
	.trim();
const pending = only
	? pendingAll.filter((venue) =>
			venue.name.toLowerCase().includes(only.toLowerCase()),
		)
	: pendingAll;

if (only) {
	console.log(
		`${pending.length} of ${pendingAll.length} venues still without coordinates match "${only}".`,
	);
}

const work = pending.slice(0, limit);
const skipped = pending.length - work.length;

if (pending.length > limit) {
	console.error(
		`Only ${limit} of ${pending.length} venues this run (--limit). Re-run to continue; each run is idempotent.`,
	);
}

console.log(
	`${dryRun ? "DRY RUN — " : ""}geocoding ${work.length} venues, ${skipped} left for later…\n`,
);

const outcomes: Outcome[] = [];

for (const venue of work) {
	// A venue with no city is not a reason to assume Leiria: `expected` stays
	// null, so any hit inside the district is allowed and the concelho it
	// landed in is recorded next to it.
	const city = venue.city ?? null;
	const fromName = scopeOfName(venue.name);

	if (fromName === "concelho") {
		outcomes.push({
			id: venue.id,
			name: venue.name,
			city,
			status: "skipped",
			scope: "concelho",
			note: "named after its município: an area, not a building — the map draws it from the concelho outline",
		});
		if (!dryRun) {
			await db
				.update(schema.venues)
				.set({ scope: "concelho" })
				.where(eq(schema.venues.id, venue.id));
		}
		console.log(`  skip (município): ${venue.name}`);
		continue;
	}

	const expected = municipalityOf(city);
	const shape = expected ? byName.get(expected) : undefined;
	const viewbox = shape ? boundsOf(shape) : districtBox;

	// Questions, most specific first. The bounded one is what rescues a venue
	// name that means nothing outside its own concelho. Names arrive with the
	// source's own qualifiers still attached, so the last two ask again about
	// the same name with less of it: the parenthetical a source appended
	// ("The Lighthouse Meeting Centre (Igreja Verbo da Vida Leiria)"), and the
	// city the name ends with ("TEXAS Club Leiria", filed under Leiria). Both
	// candidates face the same point-in-polygon test as the full name, so a
	// shortcut that lands in the wrong concelho buys nothing.
	const bare = venue.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
	const withoutCity =
		city && bare.toLowerCase().endsWith(city.toLowerCase())
			? bare
					.slice(0, -city.length)
					.replace(/[\s,–—-]+$/, "")
					.trim()
			: "";

	const attempts: { label: string; query: string; viewbox?: typeof viewbox }[] =
		[
			...(city
				? [{ label: "name+city", query: `${venue.name}, ${city}, Portugal` }]
				: []),
			{ label: "bounded", query: `${venue.name}, Portugal`, viewbox },
			{ label: "plain", query: `${venue.name}, Portugal` },
			...(bare && bare !== venue.name
				? [{ label: "no-qualifier", query: `${bare}, Portugal`, viewbox }]
				: []),
			...(withoutCity
				? [
						{
							label: "no-city",
							query: `${withoutCity}, ${city}, Portugal`,
							viewbox,
						},
					]
				: []),
		];

	let landed: Outcome | null = null;
	let outsideNote = "";

	for (const attempt of attempts) {
		const hits = await search(attempt.query, attempt.viewbox);
		await sleep(MIN_DELAY_MS);
		if (hits.length === 0) continue;

		for (const hit of hits) {
			const lat = Number(hit.lat);
			const lng = Number(hit.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
				outsideNote = "non-numeric coordinates";
				continue;
			}
			const concelho = concelhoAt(lng, lat, SHAPES);
			if (concelho === null) {
				outsideNote = `${hit.display_name} is outside the district`;
				continue;
			}
			if (expected && concelho !== expected) {
				outsideNote = `${hit.display_name} is in ${concelho}, not ${expected}`;
				continue;
			}
			// A bare settlement is a place standing in for "somewhere in
			// here", not a building: the name said venue, OSM says otherwise.
			const isPlace =
				hit.class === "place" && PLACE_CLASSES.has(hit.type ?? "");
			landed = {
				id: venue.id,
				name: venue.name,
				city,
				status: isPlace ? "lugar" : "ok",
				scope: isPlace ? "lugar" : "venue",
				variant: attempt.label,
				concelho,
				lat,
				lng,
				address: venue.address ? undefined : hit.display_name,
			};
			break;
		}
		if (landed) break;
	}

	if (!landed) {
		outcomes.push({
			id: venue.id,
			name: venue.name,
			city,
			status: "no-hit",
			scope: "venue",
			note: outsideNote || "Nominatim knew nothing that fit",
		});
		console.log(`  MISS: ${venue.name} (${outsideNote || "no hit"})`);
		continue;
	}

	outcomes.push(landed);
	console.log(
		`  ${landed.status}: ${venue.name} → ${landed.lat?.toFixed(5)}, ${landed.lng?.toFixed(5)} [${landed.concelho}] via ${landed.variant}`,
	);

	if (!dryRun) {
		await db
			.update(schema.venues)
			.set({
				lat: landed.lat as number,
				lng: landed.lng as number,
				scope: landed.scope,
				...(landed.address ? { address: landed.address } : {}),
			})
			.where(eq(schema.venues.id, venue.id));
	}
}

const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
	acc[o.status] = (acc[o.status] ?? 0) + 1;
	return acc;
}, {});

const report = {
	startedAt: new Date().toISOString(),
	dryRun,
	venues: work.length,
	remaining: skipped,
	wrote: dryRun ? 0 : outcomes.filter((o) => o.lat != null).length,
	tally,
	outcomes,
};

Bun.write(reportPath, JSON.stringify(report, null, 2));

console.log(`\n${JSON.stringify(tally)}`);
console.log(`report → ${reportPath}`);
if (dryRun) console.log("nothing written (--dry-run)");
