// FindLeiria build-time prerender: the static JSON snapshot the SPA reads
// (dist/data/), per-event static HTML pages with the event embedded, per-event
// OG cards, sitemap.xml and robots.txt into the Vite output directory.
// Plain Node ESM. Reads the database once, through the same query functions
// the dev API uses (packages/api/src/snapshot.ts).
//
// Run from apps/web AFTER `vite build`:  node scripts/prerender-events.mjs
// Env: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (read-only; never VITE_-prefixed).

import fs from "node:fs";
import path from "node:path";
import { buildCards, liveCardKeys, templateFingerprint } from "./og-cache.mjs";
import { OG_TEMPLATE_FILES, renderOgCard } from "./og-card.mjs";
import { createR2Cache, formatR2Stats } from "./og-r2.mjs";
import {
	APP_DIR,
	buildCredentials,
	loadSnapshotBuilder,
	remoteHost,
} from "./snapshot-lib.mjs";

const DIST = path.join(APP_DIR, "dist");
const DATA = path.join(DIST, "data");
const SITE = "https://findleiria.vercel.app";
const LISBON_TZ = "Europe/Lisbon";
// Rendered OG cards, keyed by content (see og-cache.mjs). Between builds they
// persist in an R2 bucket (og-r2.mjs); this directory is the local working copy
// (under node_modules, which Vercel also restores). A missing or empty
// directory with no R2 config is simply a cold build that renders every card.
const OG_CACHE_DIR = path.join(APP_DIR, "node_modules", ".cache", "og-cards");
const OG_CONCURRENCY = 4;

// ------------------------------------------------------------ snapshot guard
// The page has no other data source, so a build whose snapshot is missing or
// empty would ship an agenda that can only show an error. Read the files back
// from disk (not from memory) before calling the build good.
function assertSnapshotOnDisk(snapshot) {
	const nonEmpty = (file) => {
		if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
			throw new Error(
				`Snapshot file missing or empty: ${path.relative(DIST, file)}`,
			);
		}
	};
	const agendaFile = path.join(DATA, "agenda.json");
	nonEmpty(agendaFile);
	const agenda = JSON.parse(fs.readFileSync(agendaFile, "utf8"));
	if (!Array.isArray(agenda.events) || !Array.isArray(agenda.undated)) {
		throw new Error("dist/data/agenda.json is not an agenda snapshot.");
	}
	if (agenda.events.length + agenda.undated.length === 0) {
		throw new Error(
			"dist/data/agenda.json has no dated or undated events — refusing to ship an empty agenda.",
		);
	}
	for (const event of snapshot.events) {
		nonEmpty(path.join(DATA, "events", `${event.slug}.json`));
	}
	console.log(
		`snapshot guard: agenda.json (${agenda.events.length} rows, ${agenda.undated.length} undated) + ${snapshot.events.length} event files`,
	);
}

// ---------------------------------------------------- client bundle leak guard
// The bundle used to carry the Turso URL and token. Nothing in it may talk to
// the database now: fail the build if the database host or a libSQL client
// shows up in any chunk.
function assertBundleHasNoDatabase(dbUrl) {
	const assetsDir = path.join(DIST, "assets");
	if (!fs.existsSync(assetsDir)) {
		throw new Error(`Missing ${assetsDir} — run this after vite build.`);
	}
	const host = remoteHost(dbUrl);
	const needles = ["libsql", "VITE_TURSO", ...(host ? [host] : [])];
	for (const file of fs
		.readdirSync(assetsDir)
		.filter((f) => f.endsWith(".js"))) {
		const code = fs.readFileSync(path.join(assetsDir, file), "utf8");
		const hit = needles.find((needle) => code.includes(needle));
		if (hit) {
			throw new Error(
				`Client bundle ${file} contains "${hit}": the SPA must read the static snapshot, never the database.`,
			);
		}
	}
	console.log(
		"bundle guard: no database client or credentials in the JS chunks",
	);
}

// ------------------------------------------------------------------ entities
// Decode common HTML entities + numeric references BEFORE any escaping.
const NAMED = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	rsquo: "\u2019",
	lsquo: "\u2018",
	ldquo: "\u201c",
	rdquo: "\u201d",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	middot: "\u00b7",
	aacute: "á",
	eacute: "é",
	iacute: "í",
	oacute: "ó",
	uacute: "ú",
	agrave: "à",
	egrave: "è",
	igrave: "ì",
	ograve: "ò",
	ugrave: "ù",
	acirc: "â",
	ecirc: "ê",
	icirc: "î",
	ocirc: "ô",
	ucirc: "û",
	atilde: "ã",
	otilde: "õ",
	ccedil: "ç",
	ntilde: "ñ",
	uuml: "ü",
	ouml: "ö",
	auml: "ä",
	euml: "ë",
	iuml: "ï",
	Ccedil: "Ç",
	Aacute: "Á",
	Eacute: "É",
	Iacute: "Í",
	Oacute: "Ó",
	Uacute: "Ú",
	Ntilde: "Ñ",
	deg: "°",
	times: "×",
	raquo: "»",
	laquo: "«",
	euro: "€",
	copy: "©",
	reg: "®",
};

function decodeEntities(text) {
	if (typeof text !== "string" || !text) return text;
	return text.replace(
		/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g,
		(whole, body) => {
			if (body[0] === "#") {
				const hex = body[1] === "x" || body[1] === "X";
				const num = Number.parseInt(
					hex ? body.slice(2) : body.slice(1),
					hex ? 16 : 10,
				);
				if (!Number.isNaN(num) && num > 0 && num <= 0x10ffff) {
					try {
						return String.fromCodePoint(num);
					} catch {
						return whole;
					}
				}
				return whole;
			}
			return body in NAMED ? NAMED[body] : whole;
		},
	);
}

function escapeHTML(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// ------------------------------------------------------------- time helpers
function dateOnlyFromEpoch(epochSeconds) {
	const d = new Date(epochSeconds * 1000);
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: LISBON_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(d);
	const get = (t) => parts.find((p) => p.type === t)?.value;
	return `${get("year")}-${get("month")}-${get("day")}`;
}

const PT_MONTHS = [
	"",
	"jan",
	"fev",
	"mar",
	"abr",
	"mai",
	"jun",
	"jul",
	"ago",
	"set",
	"out",
	"nov",
	"dez",
];

function lisbonDayLabel(epochSeconds) {
	const d = new Date(epochSeconds * 1000);
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: LISBON_TZ,
		day: "numeric",
		month: "numeric",
		year: "numeric",
	}).formatToParts(d);
	const get = (t) => Number(parts.find((p) => p.type === t)?.value);
	return `${get("day")} ${PT_MONTHS[get("month")]} ${get("year")}`;
}

// ---------------------------------------------------------------- JSON-LD
// `row` is one `eventDirectory` row (packages/api/src/queries/events.ts).
function buildJsonLd(row) {
	// No parseable machine date => no Event JSON-LD at all.
	if (row.dateText) return null;

	const startAt =
		typeof row.startAt === "number" && row.startAt > 0 ? row.startAt : null;
	if (startAt === null) return null; // no machine date, nothing consistent to say

	const url = `${SITE}/evento/${row.slug}`;
	const hasVenue = Boolean(row.venueName);

	const graph = {
		"@context": "https://schema.org",
		"@type": "Event",
		name: row.title ? decodeEntities(row.title) : "",
		url,
		startDate: dateOnlyFromEpoch(startAt),
		eventStatus: "https://schema.org/EventScheduled",
	};

	if (typeof row.endAt === "number" && row.endAt > 0) {
		graph.endDate = dateOnlyFromEpoch(row.endAt);
	}

	if (row.imageUrl) {
		graph.image = decodeEntities(row.imageUrl);
	}

	if (hasVenue) {
		graph.location = {
			"@type": "Place",
			name: decodeEntities(row.venueName),
			address: {
				"@type": "PostalAddress",
				addressLocality: row.venueCity
					? decodeEntities(row.venueCity)
					: "Leiria",
				addressRegion: "Leiria",
				addressCountry: "PT",
			},
		};
		graph.eventAttendanceMode = "https://schema.org/OfflineEventAttendanceMode";
	}

	if (row.description) {
		graph.description = decodeEntities(row.description);
	}

	if (row.url) {
		graph.offers = { "@type": "Offer", url: decodeEntities(row.url) };
	}

	return graph;
}

// ---------------------------------------------------------------- main
async function main() {
	const t0 = Date.now();
	const { url: dbUrl, token } = buildCredentials();
	assertBundleHasNoDatabase(dbUrl);

	const { buildSnapshot, writeSnapshot, createReadDb, EMBEDDED_EVENT_ID } =
		await loadSnapshotBuilder();
	const db = createReadDb(dbUrl, token);
	let snapshot;
	try {
		snapshot = await buildSnapshot(db);
	} catch (err) {
		console.error("[prerender] database read FAILED:", err);
		process.exit(1);
	} finally {
		db.$client.close();
	}

	// Every event, newest first, with its description: pages, cards, sitemap.
	const rows = snapshot.events;
	if (rows.length === 0) {
		console.error(
			"[prerender] FAIL: query returned 0 events — refusing to write a build with no pages.",
		);
		process.exit(1);
	}

	const written = writeSnapshot(DATA, snapshot);
	assertSnapshotOnDisk(snapshot);
	console.log(
		`[prerender] snapshot: ${written.files} files, ${(written.bytes / 1024).toFixed(0)} KB in dist/data`,
	);

	// Base page template
	const distIndex = path.join(DIST, "index.html");
	if (!fs.existsSync(distIndex)) {
		console.error(
			"[prerender] FAIL: dist/index.html not found. Run `vite build` first.",
		);
		process.exit(1);
	}
	const baseHtml = fs.readFileSync(distIndex, "utf8");
	const ORIG_TITLE = "<title>FindLeiria — o que se passa em Leiria</title>";
	const ORIG_DESC =
		/<meta\n\s+name="description"\n\s+content="[^"]*"\s*\/>/.exec(
			baseHtml,
		)?.[0];
	if (!ORIG_DESC) {
		console.error(
			"[prerender] FAIL: could not locate the description <meta> tag in dist/index.html.",
		);
		process.exit(1);
	}

	// Idempotency: wipe previous runs
	for (const sub of ["evento", "og"]) {
		fs.rmSync(path.join(DIST, sub), { recursive: true, force: true });
	}

	// ---- OG cards for every event, past ones included: their pages are still
	// prerendered and still name /og/<slug>.png, and a shared link keeps its
	// preview. Unchanged cards come from the cache, so a past event costs a
	// file copy, not a render; only new or edited events are drawn.
	const cardEntries = rows.map((row) => {
		const hasMachineDate =
			!row.dateText && typeof row.startAt === "number" && row.startAt > 0;
		return {
			slug: String(row.slug || "").trim(),
			title: (row.title ? decodeEntities(row.title) : "") || "Evento",
			dayLabel: hasMachineDate
				? lisbonDayLabel(row.startAt)
				: row.dateText
					? decodeEntities(row.dateText)
					: "",
			venueLabel: row.venueName ? decodeEntities(row.venueName) : "Leiria",
		};
	});
	if (cardEntries.some((entry) => !entry.slug)) {
		throw new Error("Row with empty slug encountered.");
	}
	const fingerprint = templateFingerprint(OG_TEMPLATE_FILES);
	const liveKeys = liveCardKeys(cardEntries, fingerprint);
	// Remote cache: fetch what this build needs, render the rest, then upload the
	// new cards and drop the unused ones. Never fails the build (og-r2.mjs).
	const r2 = createR2Cache({ cacheDir: OG_CACHE_DIR });
	await r2.pull(liveKeys);
	const cardStats = await buildCards({
		entries: cardEntries,
		cacheDir: OG_CACHE_DIR,
		outDir: path.join(DIST, "og"),
		fingerprint,
		render: renderOgCard,
		concurrency: OG_CONCURRENCY,
	});
	await r2.push(cardStats.renderedKeys);
	await r2.prune(liveKeys);
	if (r2.enabled) console.log(formatR2Stats(r2.stats));
	console.log(
		`[prerender] og cards: ${cardStats.rendered} rendered, ${cardStats.reused} from cache, ${cardStats.evicted} evicted`,
	);

	let pagesWritten = 0;
	const sitemapUrls = [];

	for (const row of rows) {
		const slug = String(row.slug || "").trim();
		if (!slug) throw new Error("Row with empty slug encountered.");
		const titleText = row.title ? decodeEntities(row.title) : "";
		const descText = row.description ? decodeEntities(row.description) : "";

		// ---- per-event HTML page
		const jsonLd = buildJsonLd(row);
		const pageUrl = `${SITE}/evento/${slug}`;
		const ogImageUrl = `${SITE}/og/${slug}.png`;

		let html = baseHtml;
		// Replacer functions throughout: with a string, a `$&` in event text
		// (an escaped `$'` becomes `$&#39;`) would splice in the matched tag.
		html = html.replace(
			ORIG_TITLE,
			() => `<title>${escapeHTML(titleText || "Evento")} — FindLeiria</title>`,
		);
		html = html.replace(
			ORIG_DESC,
			() =>
				`<meta\n      name="description"\n      content="${escapeHTML(descText || titleText || "")}"\n    />`,
		);

		const headTags =
			`<link rel="canonical" href="${pageUrl}" />\n` +
			`<meta property="og:type" content="article" />\n` +
			`<meta property="og:title" content="${escapeHTML(titleText || "Evento")}" />\n` +
			`<meta property="og:description" content="${escapeHTML(descText || titleText || "")}" />\n` +
			`<meta property="og:image" content="${ogImageUrl}" />\n` +
			`<meta property="og:url" content="${pageUrl}" />\n` +
			`<meta name="twitter:card" content="summary_large_image" />\n` +
			`<meta name="twitter:title" content="${escapeHTML(titleText || "Evento")}" />\n` +
			`<meta name="twitter:description" content="${escapeHTML(descText || titleText || "")}" />\n` +
			`<meta name="twitter:image" content="${ogImageUrl}" />\n` +
			"</head>\n";

		// The event itself, so the SPA paints this page on a cold load without a
		// request or a skeleton (read by readEmbeddedEvent in src/utils/snapshot.ts).
		// `<` is escaped so no field can close the script element.
		const embedded = JSON.stringify(row).replace(/</g, "\\u003c");
		let insertSnippet = `<script type="application/json" id="${EMBEDDED_EVENT_ID}">${embedded}</script>\n${headTags}`;
		if (jsonLd) {
			const json = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
			insertSnippet = `<script type="application/ld+json">${json}</script>\n${insertSnippet}`;
		}

		const beforeHead = html;
		html = html.replace("</head>\n", () => insertSnippet);
		if (html === beforeHead) {
			throw new Error(
				`Could not find the </head> insertion point for ${slug} — Vite's index.html changed shape.`,
			);
		}

		const pageDir = path.join(DIST, "evento", slug);
		fs.mkdirSync(pageDir, { recursive: true });
		fs.writeFileSync(path.join(pageDir, "index.html"), html);

		pagesWritten += 1;

		// ---- sitemap entry
		const lastmod =
			typeof row.updatedAt === "number" && row.updatedAt > 0
				? new Date(row.updatedAt * 1000).toISOString().slice(0, 10)
				: new Date(Date.now()).toISOString().slice(0, 10);
		sitemapUrls.push({ loc: pageUrl, lastmod });
	}

	if (pagesWritten !== rows.length) {
		console.error(
			`[prerender] FAIL: wrote ${pagesWritten} event pages but the query returned ${rows.length} rows — aborting.`,
		);
		process.exit(1);
	}

	// ---- sitemap.xml (home + every event page)
	const latest = sitemapUrls.reduce(
		(mx, u) => (u.lastmod > mx ? u.lastmod : mx),
		"",
	);
	const urlXml = sitemapUrls
		.map(
			(u) =>
				`  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`,
		)
		.join("\n");
	const sitemap =
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
		`  <url>\n    <loc>${SITE}/</loc>\n    <lastmod>${latest}</lastmod>\n  </url>\n` +
		`${urlXml}\n</urlset>\n`;
	fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);

	// ---- robots.txt
	fs.writeFileSync(
		path.join(DIST, "robots.txt"),
		`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`,
	);

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log(
		`[prerender] done in ${elapsed}s — ${pagesWritten} event pages, ${sitemapUrls.length} sitemap URLs.`,
	);
}

main().catch((err) => {
	console.error("[prerender] FAIL:", err);
	process.exit(1);
});
