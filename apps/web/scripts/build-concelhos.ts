/**
 * Builds the município outlines the activity map draws (SLICE_14).
 *
 * One-off generator, run by hand and committed: the app must never call a
 * geocoder at runtime or at build time, so the shapes live in
 * `src/assets/concelhos.json` as a static asset.
 *
 *   bun run concelhos:build
 *
 * Source: Nominatim (`polygon_geojson=1`), the município administrative
 * relation — verified per feature by point-in-polygon against the hit's own
 * centre before it is written, so a wrong match fails loudly here instead of
 * drawing a wrong shape in production. Policy: 1 request/second, custom UA.
 *
 * Simplification: Douglas–Peucker per ring. A district outline for a choropleth
 * needs the coastline's shape, not its survey — the tolerance below keeps the
 * district recognisable at ~1/20th of the payload.
 */
import { writeFile } from "node:fs/promises";

import { DISTRICT_MUNICIPALITIES } from "@events-tracker/api/places";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "findleiria/0.1 (pedro@porta443.com)";
const DELAY_MS = 1200;
const TIMEOUT_MS = 30_000;

/** Degrees. ~130 m at this latitude — coast and municipal borders survive. */
const TOLERANCE = 0.0012;
/** Rings smaller than this (bbox diagonal, degrees) are islets and specks. */
const MIN_RING_SPAN = 0.004;

const OUT = new URL("../src/assets/concelhos.json", import.meta.url);

type Position = [number, number]; // [lng, lat]
type Ring = Position[];
type MultiPolygon = Ring[][];

type Hit = {
	lat: string;
	lon: string;
	class?: string;
	type?: string;
	place_rank?: number;
	display_name?: string;
	name?: string;
	geojson?: { type: string; coordinates: unknown };
	address?: Record<string, string>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(query: string): Promise<Hit[]> {
	// jsonv1 (`format=json`), not jsonv2: v1 is the response shape that carries
	// `class` and `place_rank`, which is what tells a município boundary apart
	// from the village of the same name.
	const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&polygon_geojson=1&limit=10&addressdetails=1`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, "Accept-Language": "pt" },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as Hit[];
	} finally {
		clearTimeout(timer);
	}
}

/** Ring area (shoelace, absolute). Used to rank rings and drop specks. */
function ringArea(ring: Ring): number {
	let sum = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		const a = ring[i];
		const b = ring[i + 1];
		if (!a || !b) continue;
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return Math.abs(sum / 2);
}

function span(ring: Ring): number {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of ring) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return Math.hypot(maxX - minX, maxY - minY);
}

/** Perpendicular distance from p to segment ab, in degrees. */
function distanceToSegment(p: Position, a: Position, b: Position): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker. Iterative: a district ring is thousands of points deep. */
function simplify(ring: Ring, tolerance: number): Ring {
	if (ring.length <= 4) return ring;
	const keep = new Uint8Array(ring.length);
	keep[0] = 1;
	keep[ring.length - 1] = 1;

	const stack: [number, number][] = [[0, ring.length - 1]];
	while (stack.length > 0) {
		const [first, last] = stack.pop() as [number, number];
		let index = -1;
		let maxDistance = tolerance;
		for (let i = first + 1; i < last; i++) {
			const distance = distanceToSegment(
				ring[i] as Position,
				ring[first] as Position,
				ring[last] as Position,
			);
			if (distance > maxDistance) {
				maxDistance = distance;
				index = i;
			}
		}
		if (index !== -1) {
			keep[index] = 1;
			stack.push([first, index], [index, last]);
		}
	}

	const out: Ring = [];
	for (let i = 0; i < ring.length; i++) {
		const point = ring[i];
		if (keep[i] && point) out.push([round(point[0]), round(point[1])]);
	}
	// A ring needs three distinct vertices plus the closing repeat.
	return out.length >= 4 ? out : ring;
}

const round = (value: number) => Math.round(value * 1e5) / 1e5;

function pointInRing(point: Position, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i] as Position;
		const b = ring[j] as Position;
		const intersects =
			a[1] > point[1] !== b[1] > point[1] &&
			point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
		if (intersects) inside = !inside;
	}
	return inside;
}

function pointInMultiPolygon(point: Position, polygons: MultiPolygon): boolean {
	for (const polygon of polygons) {
		const [outer, ...holes] = polygon;
		if (!outer || !pointInRing(point, outer)) continue;
		if (holes.some((hole) => pointInRing(point, hole))) continue;
		return true;
	}
	return false;
}

/**
 * A point guaranteed to be inside the shape to hang the label on.
 *
 * The centre of the largest ring is the natural anchor, but a município like
 * Peniche or Alcobaça is concave enough that its centre can land in the sea or
 * in the neighbouring concelho. So: try the centre, then walk a grid inside the
 * bounding box and take the inside point nearest to it.
 */
function labelAnchor(polygons: MultiPolygon): Position {
	const largest = [...polygons].sort(
		(a, b) => ringArea(b[0] as Ring) - ringArea(a[0] as Ring),
	)[0] as Ring[];
	const outer = largest[0] as Ring;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of outer) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}

	let cx = 0;
	let cy = 0;
	for (const [x, y] of outer) {
		cx += x;
		cy += y;
	}
	const centre: Position = [cx / (outer.length - 1), cy / (outer.length - 1)];
	if (pointInMultiPolygon(centre, polygons))
		return [round(centre[0]), round(centre[1])];

	const steps = 24;
	let best: Position | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 1; i < steps; i++) {
		for (let j = 1; j < steps; j++) {
			const candidate: Position = [
				minX + ((maxX - minX) * i) / steps,
				minY + ((maxY - minY) * j) / steps,
			];
			if (!pointInMultiPolygon(candidate, polygons)) continue;
			const distance = Math.hypot(
				candidate[0] - centre[0],
				candidate[1] - centre[1],
			);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
	}
	if (!best) throw new Error("no interior point found");
	return [round(best[0]), round(best[1])];
}

function toMultiPolygon(geometry: {
	type: string;
	coordinates: unknown;
}): MultiPolygon {
	if (geometry.type === "MultiPolygon") {
		return geometry.coordinates as MultiPolygon;
	}
	if (geometry.type === "Polygon") {
		return [geometry.coordinates as Ring[]];
	}
	throw new Error(`unsupported geometry ${geometry.type}`);
}

/**
 * The município relation, not a freguesia or a village of the same name.
 *
 * Nominatim answers "Alcobaça, Portugal" with the concelho relation, whose
 * address carries `county: "Leiria"` (and `ISO3166-2-lvl6: "PT-10"`, the
 * district code) — that pair is what actually distinguishes "Pombal, Leiria"
 * from the other four Pombals in the country. A hit without either is not
 * trusted, and a hit whose centroid falls outside its own polygon is rejected
 * by the caller.
 */
const DISTRICT_CODE = "PT-10";

function muniKey(hit: Hit): string {
	return (hit.address?.county ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function pickMunicipality(hits: Hit[], name: string): Hit {
	const viable = hits.filter(
		(hit) =>
			hit.class === "boundary" &&
			hit.type === "administrative" &&
			hit.geojson &&
			(hit.geojson.type === "Polygon" || hit.geojson.type === "MultiPolygon"),
	);
	const inDistrict = viable.filter(
		(hit) =>
			hit.address?.["ISO3166-2-lvl6"] === DISTRICT_CODE ||
			muniKey(hit) === "leiria",
	);
	const wanted = name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
	const named = (hit: Hit) =>
		(hit.name ?? "")
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase();
	const exact = inDistrict.find((hit) => named(hit) === wanted);
	const chosen =
		exact ?? inDistrict.find((hit) => hit.place_rank === 14) ?? inDistrict[0];
	if (!chosen) {
		throw new Error(
			`no district boundary hit for ${name} (tried ${hits.length} hits: ${hits
				.slice(0, 4)
				.map((h) => `${h.class}/${h.type} ${h.display_name?.slice(0, 40)}`)
				.join("; ")})`,
		);
	}
	return chosen;
}

type Feature = {
	type: "Feature";
	properties: { name: string; anchor: Position };
	geometry: { type: "MultiPolygon"; coordinates: MultiPolygon };
};

const features: Feature[] = [];
const report: string[] = [];

for (const [index, name] of DISTRICT_MUNICIPALITIES.entries()) {
	if (index > 0) await sleep(DELAY_MS);
	const hits = await search(`${name}, Portugal`);
	const hit = pickMunicipality(hits, name);

	const raw = toMultiPolygon(
		hit.geojson as { type: string; coordinates: unknown },
	);
	const centre: Position = [Number(hit.lon), Number(hit.lat)];
	if (!pointInMultiPolygon(centre, raw)) {
		throw new Error(`${name}: Nominatim centre is outside its own geometry`);
	}

	const before = raw.reduce(
		(sum, polygon) => sum + (polygon[0]?.length ?? 0),
		0,
	);
	const kept: MultiPolygon = [];
	for (const polygon of raw) {
		const rings: Ring[] = [];
		for (const [ringIndex, ring] of polygon.entries()) {
			// Holes (ringIndex > 0) are tiny and stay; outer rings drop specks.
			if (ringIndex === 0 && span(ring) < MIN_RING_SPAN) continue;
			rings.push(simplify(ring, TOLERANCE));
		}
		if (rings.length > 0) kept.push(rings);
	}
	const after = kept.reduce(
		(sum, polygon) => sum + (polygon[0]?.length ?? 0),
		0,
	);
	if (kept.length === 0)
		throw new Error(`${name}: simplification emptied the shape`);

	features.push({
		type: "Feature",
		properties: { name, anchor: labelAnchor(kept) },
		geometry: { type: "MultiPolygon", coordinates: kept },
	});
	report.push(
		`  ${name.padEnd(22)} rings ${String(kept.length).padStart(2)}  points ${String(before).padStart(5)} → ${String(after).padStart(4)}  anchor ${labelAnchor(
			kept,
		)
			.map((n) => n.toFixed(3))
			.join(",")}`,
	);
}

const payload = {
	$comment:
		"Generated by apps/web/scripts/build-concelhos.ts. Boundaries © OpenStreetMap contributors (ODbL). Do not hand-edit.",
	generated: new Date().toISOString().slice(0, 10),
	features,
};

await writeFile(OUT, `${JSON.stringify(payload)}\n`);

console.log(report.join("\n"));
console.log(
	`\n${features.length}/${DISTRICT_MUNICIPALITIES.length} municípios → ${OUT.pathname.replace(`${process.cwd()}/`, "")}`,
);
