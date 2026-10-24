import type { ThemeGroup } from "./themes";

/**
 * The tile a poster-less event gets instead of an empty box.
 *
 * A seeded mesh gradient: three soft pastel fields over a light ground, seeded
 * from the event's own identity so an event keeps the same tile on every
 * render, rebuild and prerender. Random per event, never random per render — a
 * tile that reshuffles on scroll would read as a bug and would not survive the
 * prerender → hydrate handover.
 *
 * Plain CSS `radial-gradient` layers rather than an SVG: one inline style per
 * tile instead of gradient defs and nodes per row, which matters when the
 * agenda mounts several hundred rows.
 *
 * The fields are the theme pastels (DESIGN.md), a step more saturated so a
 * tile reads as an image and not as a tag. When the event has a theme, its
 * colour is the anchor field, upper left like a light source, so a concert's
 * tile leans lilac and a market's leans peach. The other two are seeded.
 */
export type MeshGradient = {
	backgroundColor: string;
	backgroundImage: string;
};

/** Field colours as `r, g, b`, one per theme group. */
const FIELD: Record<ThemeGroup, [number, number, number]> = {
	music: [201, 184, 255],
	stage: [255, 184, 203],
	arts: [188, 220, 255],
	food: [255, 201, 163],
	outdoors: [255, 228, 140],
};

const GROUPS = Object.keys(FIELD) as ThemeGroup[];

/** FNV-1a: small, stable, and identical across builds and clients. */
function hash(input: string): number {
	let value = 0x811c9dc5;
	for (let index = 0; index < input.length; index++) {
		value ^= input.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return value >>> 0;
}

/** mulberry32 — the whole point is that the sequence is a pure function of the seed. */
function random(seed: number): () => number {
	let state = seed || 1;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Inclusive integer band, so no field ever lands off-canvas or degenerate. */
function band(next: () => number, min: number, max: number): number {
	return Math.round(min + next() * (max - min));
}

/** Pick a group other than the ones already used. */
function pickOther(next: () => number, used: ThemeGroup[]): ThemeGroup {
	const left = GROUPS.filter((group) => !used.includes(group));
	return left[Math.floor(next() * left.length) % left.length] ?? GROUPS[0];
}

const rgba = ([r, g, b]: [number, number, number], alpha: number) =>
	`rgba(${r}, ${g}, ${b}, ${alpha})`;

export function meshGradient(
	seed: string,
	theme: ThemeGroup | null = null,
): MeshGradient {
	const next = random(hash(seed));
	const anchor = theme ?? GROUPS[band(next, 0, GROUPS.length - 1)];
	const second = pickOther(next, [anchor]);
	const third = pickOther(next, [anchor, second]);

	// First layer paints on top: the anchor is the light source, upper left.
	const fields = [
		`radial-gradient(at ${band(next, 6, 34)}% ${band(next, 4, 30)}%, ${rgba(FIELD[anchor], 0.95)} 0%, ${rgba(FIELD[anchor], 0)} ${band(next, 56, 72)}%)`,
		`radial-gradient(at ${band(next, 60, 96)}% ${band(next, 52, 96)}%, ${rgba(FIELD[second], 0.9)} 0%, ${rgba(FIELD[second], 0)} ${band(next, 54, 74)}%)`,
		`radial-gradient(at ${band(next, 20, 80)}% ${band(next, 30, 70)}%, ${rgba(FIELD[third], 0.5)} 0%, ${rgba(FIELD[third], 0)} ${band(next, 48, 64)}%)`,
	];

	// The ground is the anchor washed most of the way to white, so uncovered
	// corners stay light and in the tile's own family.
	const [r, g, b] = FIELD[anchor];
	const wash = (channel: number) =>
		Math.round(channel + (255 - channel) * 0.75);

	return {
		backgroundColor: `rgb(${wash(r)}, ${wash(g)}, ${wash(b)})`,
		backgroundImage: fields.join(", "),
	};
}
