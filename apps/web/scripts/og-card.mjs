// OG card renderer for FindLeiria prerender.
// Typographic 1200x630 PNG built with satori (SVG) + @resvg/resvg-js (PNG):
// white ground, Fraunces title, pastel discs top right, as the site looks.
// No JSX: satori accepts a plain object tree of { type, props }.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAsync } from "@resvg/resvg-js";
import satori from "satori";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(SCRIPT_DIR, "..", "assets", "fonts");

/** Every file that shapes the card; the prerender hashes them into the cache key. */
export const OG_TEMPLATE_FILES = [
	fileURLToPath(import.meta.url),
	path.join(FONT_DIR, "fraunces-latin-500-normal.woff"),
	path.join(FONT_DIR, "inter-latin-600-normal.woff"),
	path.join(FONT_DIR, "inter-latin-400-normal.woff"),
];

const fonts = [
	{
		name: "Fraunces",
		data: fs.readFileSync(
			path.join(FONT_DIR, "fraunces-latin-500-normal.woff"),
		),
		weight: 500,
		style: "normal",
	},
	{
		name: "Inter",
		data: fs.readFileSync(path.join(FONT_DIR, "inter-latin-600-normal.woff")),
		weight: 600,
		style: "normal",
	},
	{
		name: "Inter",
		data: fs.readFileSync(path.join(FONT_DIR, "inter-latin-400-normal.woff")),
		weight: 400,
		style: "normal",
	},
];

/** The site's tokens (packages/ui globals.css), restated: satori reads no CSS. */
const COLOR = {
	ground: "#ffffff",
	ink: "#17221b",
	inkMuted: "#4f5b54",
	rule: "#e4e7e2",
	forest: "#1f4a34",
	forestTint: "#d8efe0",
	lilac: "#e7defe",
	pink: "#ffdbe5",
	butter: "#fff0b3",
};

/** A soft pastel disc, part off-canvas, behind the top-right corner. */
function disc(color, size, top, right) {
	return {
		type: "div",
		props: {
			style: {
				position: "absolute",
				top,
				right,
				width: size,
				height: size,
				borderRadius: size,
				backgroundColor: color,
			},
		},
	};
}

const WIDTH = 1200;
const HEIGHT = 630;

// Scale the display size down for long titles; clamp to at most 4 lines so the
// block never overflows the canvas.
function displayFontSize(length) {
	if (length <= 28) return 66;
	if (length <= 42) return 56;
	if (length <= 58) return 48;
	if (length <= 76) return 40;
	if (length <= 96) return 34;
	if (length <= 118) return 28;
	return 24;
}

/**
 * @param {object} input
 * @param {string} input.host  the site host printed top right (the host of
 *   SITE_URL); the prerender also hashes it into the cache key, so a card is
 *   never reused across hosts
 */
export async function renderOgCard({ title, dayLabel, venueLabel, host }) {
	// Some rows can have empty day/venue labels; fall back to safe text.
	const day = dayLabel?.trim() ? dayLabel.trim() : "";
	const venue = venueLabel?.trim() ? venueLabel.trim() : "Leiria";
	const titleText = title?.trim() ? title.trim() : "Evento";

	const fontSize = displayFontSize(titleText.length);

	const tree = {
		type: "div",
		props: {
			style: {
				width: WIDTH,
				height: HEIGHT,
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				backgroundColor: COLOR.ground,
				padding: "72px 80px 64px 80px",
				boxSizing: "border-box",
				position: "relative",
			},
			children: [
				disc(COLOR.butter, 360, -170, -110),
				disc(COLOR.pink, 260, 80, -150),
				disc(COLOR.lilac, 200, -90, 190),
				// Top mark
				{
					type: "div",
					props: {
						style: {
							display: "flex",
							flexDirection: "row",
							alignItems: "center",
							justifyContent: "space-between",
							width: "100%",
							fontFamily: "Inter",
							fontWeight: 400,
							fontSize: 22,
							color: COLOR.inkMuted,
						},
						children: [
							{
								type: "div",
								props: {
									style: {
										display: "flex",
										fontFamily: "Fraunces",
										fontWeight: 500,
										fontSize: 34,
										color: COLOR.ink,
										letterSpacing: "-0.02em",
									},
									children: [
										{ type: "span", props: { children: "find" } },
										{
											type: "span",
											props: {
												style: { color: COLOR.forest },
												children: "leiria",
											},
										},
									],
								},
							},
							{
								type: "div",
								props: {
									style: { marginRight: 260 },
									children: host?.trim() ?? "",
								},
							},
						],
					},
				},
				// Title block (clamped 4 lines, auto-shrunk, never overflows)
				{
					type: "div",
					props: {
						style: {
							flex: 1,
							display: "flex",
							alignItems: "center",
							justifyContent: "flex-start",
							overflow: "hidden",
							minHeight: 0,
						},
						children: [
							{
								type: "div",
								props: {
									style: {
										fontFamily: "Fraunces",
										fontWeight: 500,
										fontSize: Math.round(fontSize * 1.08),
										lineHeight: 1.08,
										letterSpacing: "-0.02em",
										color: COLOR.ink,
										// Clear of the pink disc on the right edge.
										maxWidth: 940,
										display: "-webkit-box",
										WebkitBoxOrient: "vertical",
										WebkitLineClamp: 4,
										overflow: "hidden",
										textOverflow: "ellipsis",
										textWrap: "wrap",
									},
									children: titleText,
								},
							},
						],
					},
				},
				// Bottom row: day + venue
				{
					type: "div",
					props: {
						style: {
							display: "flex",
							flexDirection: "row",
							alignItems: "center",
							justifyContent: "space-between",
							width: "100%",
							borderTop: `2px solid ${COLOR.ink}`,
							paddingTop: "26px",
						},
						children: [
							{
								type: "div",
								props: {
									style: {
										display: "flex",
										fontFamily: "Inter",
										fontWeight: 600,
										fontSize: 26,
										color: COLOR.forest,
										backgroundColor: COLOR.forestTint,
										borderRadius: 999,
										padding: day ? "8px 22px" : 0,
									},
									children: day,
								},
							},
							{
								type: "div",
								props: {
									style: {
										fontFamily: "Inter",
										fontWeight: 600,
										fontSize: 26,
										color: COLOR.inkMuted,
									},
									children: venue,
								},
							},
						],
					},
				},
			],
		},
	};

	const svg = await satori(tree, {
		width: WIDTH,
		height: HEIGHT,
		fonts,
	});

	// renderAsync rasterises on libuv's thread pool, so concurrent cards overlap
	// instead of each blocking the event loop.
	const rendered = await renderAsync(svg, {
		fitTo: { mode: "width", value: WIDTH },
	});
	return Buffer.from(rendered.asPng());
}
