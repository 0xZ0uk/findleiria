import { db, schema } from "@events-tracker/db";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";

/**
 * Shared digest core (SLICE_3). Used by the /digest Hono route and by
 * digest-cli.ts (cron runs the CLI directly against the DB — no server needed).
 */

export function parseKeywords(raw: string | undefined | null): string[] {
	return (raw ?? "")
		.split(",")
		.map((k) => k.trim().toLowerCase())
		.filter((k) => k.length > 0);
}

export function foldText(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

export function matchesKeywords(text: string, keywords: string[]): boolean {
	if (keywords.length === 0) {
		return false;
	}
	const folded = foldText(text);
	return keywords.some((k) => folded.includes(foldText(k)));
}

export interface DigestEvent {
	id: number;
	title: string;
	venue: string;
	city: string | null;
	when: string;
	startAt: number;
	url: string | null;
	/** Every source listing the event, sorted, comma-separated; null when none. */
	source: string | null;
	match: boolean;
}

export interface DigestOptions {
	/** Epoch seconds — events starting after this (default: now). */
	since?: number;
	keywords: string[];
	/**
	 * When set, only events ingested within the last N hours are included
	 * (start_at still >= since) — the "what's new" digest mode.
	 */
	newHours?: number;
}

export async function buildDigest(opts: DigestOptions): Promise<{
	since: number;
	keywords: string[];
	total: number;
	hits: number;
	events: DigestEvent[];
}> {
	const since = opts.since ?? Math.floor(Date.now() / 1000);
	const conditions = [
		gte(schema.events.start_at, since),
		isNull(schema.events.date_text),
	];
	if (opts.newHours != null) {
		conditions.push(
			gte(
				schema.events.created_at,
				Math.floor(Date.now() / 1000) - opts.newHours * 3600,
			),
		);
	}

	// One row per EVENT: its sources are folded into one comma-separated
	// list. Joining event_sources directly gave a row per (event, source), so
	// a multi-source event was listed once per source and ate the limit (C9).
	const rows = await db
		.select({
			id: schema.events.id,
			title: schema.events.title,
			description: schema.events.description,
			start_at: schema.events.start_at,
			url: schema.events.url,
			categories: schema.events.categories,
			venueName: schema.venues.name,
			venueCity: schema.venues.city,
			sources: sql<
				string | null
			>`(SELECT group_concat(${schema.eventSources.source}, ',') FROM ${schema.eventSources} WHERE ${schema.eventSources.event_id} = ${schema.events.id})`,
		})
		.from(schema.events)
		.leftJoin(schema.venues, eq(schema.events.venue_id, schema.venues.id))
		.where(and(...conditions))
		.orderBy(asc(schema.events.start_at), asc(schema.events.id))
		.limit(500);

	const events = rows.map((r) => {
		const venue = r.venueName ?? "Local desconhecido";
		const when = new Date(r.start_at * 1000).toLocaleString("pt-PT", {
			timeZone: "Europe/Lisbon",
			weekday: "long",
			day: "2-digit",
			month: "long",
			hour: "2-digit",
			minute: "2-digit",
		});
		const text = `${r.title} ${venue} ${(r.categories ?? []).join(" ")} ${r.description ?? ""}`;
		return {
			id: r.id,
			title: r.title,
			venue,
			city: r.venueCity,
			when,
			startAt: r.start_at,
			url: r.url,
			source: r.sources
				? [...new Set(r.sources.split(","))].sort().join(", ")
				: null,
			match: matchesKeywords(text, opts.keywords),
		};
	});

	return {
		since,
		keywords: opts.keywords,
		total: events.length,
		hits: events.filter((e) => e.match).length,
		events,
	};
}
