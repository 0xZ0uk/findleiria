/**
 * Small HTML-to-text helpers shared by the regex-based (non-cheerio) sources.
 * Entity decoding is NOT implemented here: it always goes through the single
 * canonical decoder in `../normalize`.
 */
import { decodeEntities } from "../normalize";

/**
 * Drop `<script>`/`<style>` bodies and every tag, turning line breaks and
 * block-level closings into spaces so adjacent paragraphs do not glue
 * together. Entities are left untouched; use `textOf` for display text.
 */
export function stripTags(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/(p|div|li|h[1-6])>/gi, " ")
		.replace(/<[^>]*>/g, " ");
}

/** Readable text of an HTML fragment: tags stripped, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
	return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}
