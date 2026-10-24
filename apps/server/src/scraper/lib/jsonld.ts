/**
 * One schema.org JSON-LD scanner for every source that reads event detail
 * pages. Pages publish the same data in different envelopes: a bare object, an
 * array of objects, a `{"@graph": [...]}` wrapper, or any nesting of those;
 * and `@type` is a string or an array, usually a subtype of Event
 * ("MusicEvent", "TheaterEvent", "Festival"...). Per-source scanners that
 * handled only one shape silently missed the others.
 */

export type JsonLdNode = Record<string, unknown>;

const LD_SCRIPT =
	/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every JSON-LD `<script>` block of a page, parsed; malformed blocks are skipped. */
export function jsonLdBlocks(html: string): unknown[] {
	const out: unknown[] = [];
	for (const m of html.matchAll(LD_SCRIPT)) {
		try {
			out.push(JSON.parse(m[1] ?? ""));
		} catch {
			// malformed block: ignore it, later blocks may be fine
		}
	}
	return out;
}

/**
 * Flatten a parsed JSON-LD value into its object nodes, in document order:
 * arrays are walked (nested too), and a `@graph` container is replaced by its
 * members (the container itself is kept only when it also carries a `@type`).
 */
export function flattenJsonLd(root: unknown): JsonLdNode[] {
	const out: JsonLdNode[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) {
				walk(item);
			}
			return;
		}
		if (value === null || typeof value !== "object") {
			return;
		}
		const node = value as JsonLdNode;
		if (node["@graph"] === undefined || node["@type"] !== undefined) {
			out.push(node);
		}
		if (node["@graph"] !== undefined) {
			walk(node["@graph"]);
		}
	};
	walk(root);
	return out;
}

/** The `@type` values of a node, with any schema.org URL prefix removed. */
export function jsonLdTypes(node: JsonLdNode): string[] {
	const raw = node["@type"];
	const list = Array.isArray(raw) ? raw : [raw];
	return list
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.replace(/^https?:\/\/schema\.org\//, ""));
}

/** Event or any subtype by naming convention (`MusicEvent`, `TheaterEvent`, `Festival`...). */
export function isEventNode(node: JsonLdNode): boolean {
	return jsonLdTypes(node).some((t) => /Event$/.test(t) || t === "Festival");
}

export interface FindEventOptions {
	/**
	 * Replace the default Event-type test. Use it when a source wants a
	 * different notion of "the event node" (e.g. any node carrying a
	 * `startDate`).
	 */
	accept?: (node: JsonLdNode) => boolean;
}

/**
 * First event node of the page across all JSON-LD blocks, or null. Defaults to
 * `isEventNode`; pass `accept` to override.
 */
export function findJsonLdEvent<T = JsonLdNode>(
	html: string,
	opts: FindEventOptions = {},
): T | null {
	const accept = opts.accept ?? isEventNode;
	for (const block of jsonLdBlocks(html)) {
		for (const node of flattenJsonLd(block)) {
			if (accept(node)) {
				return node as T;
			}
		}
	}
	return null;
}

/**
 * The ticket prices a node's `offers` state (an Offer, an AggregateOffer's
 * `lowPrice`, or an array of them): numbers or strings as published, in
 * document order. Empty when the page prices nothing.
 */
export function offerPrices(node: { offers?: unknown }): (string | number)[] {
	const out: (string | number)[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const v of value) walk(v);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const offer = value as JsonLdNode;
		const price = offer.price ?? offer.lowPrice;
		if (typeof price === "string" || typeof price === "number") {
			out.push(price);
		}
	};
	walk(node.offers);
	return out;
}
