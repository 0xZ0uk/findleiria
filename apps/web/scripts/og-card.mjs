// OG card renderer for FindLeiria prerender.
// Pure typographic 1200x630 PNG built with satori (SVG) + @resvg/resvg-js (PNG).
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
	path.join(FONT_DIR, "schibsted-grotesk-latin-800-normal.woff"),
	path.join(FONT_DIR, "karla-latin-600-normal.woff"),
	path.join(FONT_DIR, "karla-latin-400-normal.woff"),
];

const fonts = [
	{
		name: "SchibstedGrotesk",
		data: fs.readFileSync(
			path.join(FONT_DIR, "schibsted-grotesk-latin-800-normal.woff"),
		),
		weight: 800,
		style: "normal",
	},
	{
		name: "Karla",
		data: fs.readFileSync(path.join(FONT_DIR, "karla-latin-600-normal.woff")),
		weight: 600,
		style: "normal",
	},
	{
		name: "Karla",
		data: fs.readFileSync(path.join(FONT_DIR, "karla-latin-400-normal.woff")),
		weight: 400,
		style: "normal",
	},
];

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

export async function renderOgCard({ title, dayLabel, venueLabel }) {
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
				backgroundColor: "#0a0a0a",
				padding: "72px 80px 64px 80px",
				boxSizing: "border-box",
			},
			children: [
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
							fontFamily: "Karla",
							fontWeight: 400,
							fontSize: 22,
							color: "#8b8b8b",
							letterSpacing: "0.06em",
						},
						children: [
							{ type: "div", props: { style: {}, children: "findleiria" } },
							{
								type: "div",
								props: { style: {}, children: "findleiria.vercel.app" },
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
										fontFamily: "SchibstedGrotesk",
										fontWeight: 800,
										fontSize,
										lineHeight: 1.06,
										color: "#ffffff",
										maxWidth: "100%",
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
							borderTop: "1px solid #232323",
							paddingTop: "26px",
						},
						children: [
							{
								type: "div",
								props: {
									style: {
										fontFamily: "Karla",
										fontWeight: 600,
										fontSize: 26,
										color: "#d9d9d9",
									},
									children: day,
								},
							},
							{
								type: "div",
								props: {
									style: {
										fontFamily: "Karla",
										fontWeight: 600,
										fontSize: 26,
										color: "#e8b44a",
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
