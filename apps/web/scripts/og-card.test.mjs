// bun test for the OG card renderer.
// Proves: renderOgCard returns a PNG (magic bytes), declares exactly 1200x630 in
// the IHDR chunk, and produces a non-trivial buffer.

import { expect, test } from "bun:test";
import { renderOgCard } from "./og-card.mjs";

function ihdrDimensions(buf) {
	// PNG: 8-byte signature, then IHDR chunk: 4 len, 4 type "IHDR", 4 width, 4 height.
	if (buf.length < 24) return null;
	const offset = 16;
	const width = buf.readUInt32BE(offset);
	const height = buf.readUInt32BE(offset + 4);
	return { width, height };
}

test("renderOgCard produces a valid 1200x630 PNG with non-trivial size", async () => {
	const buf = await renderOgCard({
		title:
			"Concerto de Verão no Jardim Público de Leiria com várias bandas e convidados especiais",
		dayLabel: "12 set 2026",
		venueLabel: "Jardim Público de Leiria",
	});

	expect(Buffer.isBuffer(buf)).toBe(true);

	// PNG magic bytes: \x89PNG\r\n\x1a\n
	expect(buf.subarray(0, 8)).toEqual(
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	);
	expect(buf.readUInt32BE(12)).toBe(0x49484452); // "IHDR" after length

	const { width, height } = ihdrDimensions(buf);
	expect(width).toBe(1200);
	expect(height).toBe(630);

	expect(buf.length).toBeGreaterThan(1000);
});

test("renderOgCard handles very long titles and empty labels without failing", async () => {
	const buf = await renderOgCard({
		title:
			"Um evento com um título extremamente longo para testar o ajuste automático de tamanho da tipografia que nunca deve transbordar da tela do cartão",
		dayLabel: "",
		venueLabel: "",
	});
	expect(buf.length).toBeGreaterThan(1000);
});
