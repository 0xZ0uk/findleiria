import { db, schema } from "@events-tracker/db";
import { asc, eq } from "drizzle-orm";

import { DEFAULT_VENUE as CALDAS_CITY } from "./caldas";
import { fingerprint, fingerprintUndated } from "./fingerprint";
import { SITES as MUNICIPAL_SITES } from "./municipal";
import { cityKey, pickVenue, type VenueRow } from "./venue-city";

/**
 * One-off repair for C3 (same-named venues in different towns were one row,
 * and the town was not part of the event fingerprint).
 *
 * Usage (from apps/server):
 *   bun run src/scraper/repair-venue-towns.ts            # dry run: print the plan
 *   bun run src/scraper/repair-venue-towns.ts --apply    # write it (one transaction)
 *
 * Optional: ingest already converges the DB on the next normal scrape (a raw
 * that finds its pre-C3 row moves it to its town and its new fingerprint).
 * This applies what the DB alone can prove, ahead of that:
 *
 *   1. MOVE events to the right town's venue when their attributions say so.
 *      The raw city was never stored, so the only town evidence is a source
 *      that always lists one town: each municipal site (by URL origin),
 *      Caldas da Rainha's agenda, CM Leiria's RSS. Only the attribution that
 *      MINTED the row counts (the row's title/time/venue are that raw's): if
 *      it names a town other than the venue's, the event is re-pointed at that
 *      town's same-named venue — created town-qualified
 *      (`mercado-municipal-batalha`) when missing. A LATER attribution naming
 *      another town is a pre-C3 collision (a second town's event glued onto
 *      this row); it is reported, not split — the next scrape recreates that
 *      event and detaches the attribution.
 *   2. REHASH every event whose stored fingerprint is exactly the pre-C3 hash
 *      of (title, venue name, time) to the town-qualified hash. A fingerprint
 *      that matches neither (venue re-pointed to a spelling variant, or
 *      rewritten by reconcile) cannot be re-derived — the raw's own venue
 *      string is gone — and is left for the next scrape.
 *
 * Never touches event slugs. Idempotent: a repaired DB plans nothing.
 */

/** Town an attribution proves, when its source only ever lists one town. */
export function evidenceTown(
	source: string,
	sourceUrl: string | null,
): string | null {
	if (source === "cmleiriarss") return "Leiria";
	if (source === "caldas") return CALDAS_CITY;
	if (source === "municipal" && sourceUrl) {
		const site = MUNICIPAL_SITES.find((s) => sourceUrl.startsWith(s.origin));
		return site?.city ?? null;
	}
	return null;
}

export type RepairOp =
	| {
			kind: "createVenue";
			tempId: number;
			name: string;
			city: string;
			slug: string;
	  }
	| { kind: "setVenueCity"; venueId: number; city: string }
	| { kind: "moveEvent"; eventId: number; slug: string; venueId: number }
	| { kind: "rehash"; eventId: number; slug: string; fingerprint: string };

export interface RepairPlan {
	ops: RepairOp[];
	events: number;
	alreadyCurrent: number;
	/** Fingerprint matches neither the pre-C3 nor the new hash of the row. */
	unverifiable: number;
	/** Pre-C3 hash, but its new hash is already held by another row. */
	conflicts: { eventId: number; slug: string; holder: number }[];
	/** A later attribution names another town: a pre-C3 collision we cannot split. */
	collisions: { eventId: number; slug: string; towns: string[] }[];
	venueless: number;
}

export async function planRepair(): Promise<RepairPlan> {
	const venueRows = await db
		.select({
			id: schema.venues.id,
			name: schema.venues.name,
			city: schema.venues.city,
			slug: schema.venues.slug,
		})
		.from(schema.venues);
	const venues = new Map<number, VenueRow>(venueRows.map((v) => [v.id, v]));

	const events = await db
		.select({
			id: schema.events.id,
			slug: schema.events.slug,
			title: schema.events.title,
			start_at: schema.events.start_at,
			date_text: schema.events.date_text,
			venue_id: schema.events.venue_id,
			fingerprint: schema.events.fingerprint,
		})
		.from(schema.events)
		.orderBy(schema.events.id);

	// Attributions oldest first: the first one is the raw that MINTED the row
	// (its title, time and venue name are that raw's). Only the minter's town
	// may move the row; a later attribution naming another town is the pre-C3
	// collision mark (a second town's event glued on as "unchanged").
	const attributions = await db
		.select({
			event_id: schema.eventSources.event_id,
			source: schema.eventSources.source,
			source_url: schema.eventSources.source_url,
		})
		.from(schema.eventSources)
		.orderBy(
			asc(schema.eventSources.first_seen_at),
			asc(schema.eventSources.id),
		);
	const minterTown = new Map<number, string | null>();
	const otherTowns = new Map<number, Map<string, string>>();
	for (const a of attributions) {
		const town = evidenceTown(a.source, a.source_url);
		const usable = town != null && cityKey(town) !== "" ? town : null;
		if (!minterTown.has(a.event_id)) {
			minterTown.set(a.event_id, usable);
			continue;
		}
		if (usable == null) continue;
		const byKey = otherTowns.get(a.event_id) ?? new Map<string, string>();
		byKey.set(cityKey(usable), usable);
		otherTowns.set(a.event_id, byKey);
	}

	const fpHolder = new Map<string, number>(
		events.map((e) => [e.fingerprint, e.id]),
	);
	const plan: RepairPlan = {
		ops: [],
		events: events.length,
		alreadyCurrent: 0,
		unverifiable: 0,
		conflicts: [],
		collisions: [],
		venueless: 0,
	};
	let tempId = -1;

	for (const e of events) {
		let venue = e.venue_id != null ? venues.get(e.venue_id) : undefined;
		if (!venue) {
			plan.venueless++;
			continue;
		}

		const town = minterTown.get(e.id) ?? null;
		const rowTown = town ?? venue.city;
		const others = [...(otherTowns.get(e.id)?.entries() ?? [])].filter(
			([key]) => key !== cityKey(rowTown),
		);
		if (others.length > 0) {
			plan.collisions.push({
				eventId: e.id,
				slug: e.slug,
				towns: others.map(([, t]) => t).sort(),
			});
		}
		if (town != null && cityKey(town) !== cityKey(venue.city)) {
			// Same resolution rule ingest uses for a raw in that town.
			const pick = pickVenue(venue.name, town, [...venues.values()]);
			let targetId: number;
			if (pick.kind === "create") {
				targetId = tempId--;
				plan.ops.push({
					kind: "createVenue",
					tempId: targetId,
					name: pick.name,
					city: pick.city,
					slug: pick.slug,
				});
				venues.set(targetId, {
					id: targetId,
					name: pick.name,
					city: pick.city,
					slug: pick.slug,
				});
			} else {
				targetId = pick.id;
				const target = venues.get(pick.id);
				if (pick.setCity && target) {
					plan.ops.push({
						kind: "setVenueCity",
						venueId: pick.id,
						city: pick.setCity,
					});
					venues.set(pick.id, { ...target, city: pick.setCity });
				}
			}
			if (targetId !== venue.id) {
				plan.ops.push({
					kind: "moveEvent",
					eventId: e.id,
					slug: e.slug,
					venueId: targetId,
				});
			}
			venue = venues.get(targetId) ?? venue;
		}

		const hash = (city: string | null) =>
			e.date_text != null
				? fingerprintUndated(e.title, venue.name, city)
				: fingerprint(e.title, venue.name, e.start_at, city);
		const target = hash(venue.city);
		if (e.fingerprint === target) {
			plan.alreadyCurrent++;
			continue;
		}
		if (e.fingerprint !== hash(null)) {
			plan.unverifiable++;
			continue;
		}
		const holder = fpHolder.get(target);
		if (holder !== undefined && holder !== e.id) {
			plan.conflicts.push({ eventId: e.id, slug: e.slug, holder });
			continue;
		}
		fpHolder.delete(e.fingerprint);
		fpHolder.set(target, e.id);
		plan.ops.push({
			kind: "rehash",
			eventId: e.id,
			slug: e.slug,
			fingerprint: target,
		});
	}
	return plan;
}

export async function applyRepair(plan: RepairPlan): Promise<void> {
	await db.transaction(async (tx) => {
		const realId = new Map<number, number>();
		const idOf = (id: number) => (id < 0 ? realId.get(id) : id);
		for (const op of plan.ops) {
			if (op.kind === "createVenue") {
				const [row] = await tx
					.insert(schema.venues)
					.values({ name: op.name, city: op.city, slug: op.slug })
					.returning({ id: schema.venues.id });
				if (!row) throw new Error(`could not create venue ${op.slug}`);
				realId.set(op.tempId, row.id);
			} else if (op.kind === "setVenueCity") {
				await tx
					.update(schema.venues)
					.set({ city: op.city })
					.where(eq(schema.venues.id, op.venueId));
			} else if (op.kind === "moveEvent") {
				const venueId = idOf(op.venueId);
				if (venueId === undefined)
					throw new Error(`unmapped venue ${op.venueId}`);
				await tx
					.update(schema.events)
					.set({ venue_id: venueId })
					.where(eq(schema.events.id, op.eventId));
			} else {
				await tx
					.update(schema.events)
					.set({ fingerprint: op.fingerprint })
					.where(eq(schema.events.id, op.eventId));
			}
		}
	});
}

export function describePlan(plan: RepairPlan, sample = 20): string[] {
	const lines: string[] = [];
	const count = (k: RepairOp["kind"]) =>
		plan.ops.filter((o) => o.kind === k).length;
	lines.push(
		`events scanned: ${plan.events}`,
		`venues to create (town-qualified): ${count("createVenue")}`,
		`unknown-town venues to give a town: ${count("setVenueCity")}`,
		`events to move to their town's venue: ${count("moveEvent")}`,
		`fingerprints to rehash with the town: ${count("rehash")}`,
		`already current: ${plan.alreadyCurrent}`,
		`not re-derivable (left for the next scrape): ${plan.unverifiable}`,
		`rehash conflicts (new hash already taken, left as is): ${plan.conflicts.length}`,
		`pre-C3 collisions: another town's attribution on the row (not split): ${plan.collisions.length}`,
		`events without a venue: ${plan.venueless}`,
	);
	for (const op of plan.ops) {
		if (op.kind === "createVenue") {
			lines.push(`  + venue ${op.slug} "${op.name}" (${op.city})`);
		} else if (op.kind === "setVenueCity") {
			lines.push(`  ~ venue #${op.venueId} city → ${op.city}`);
		} else if (op.kind === "moveEvent") {
			lines.push(`  → event ${op.slug} to venue #${op.venueId}`);
		}
	}
	const rehash = plan.ops.filter((o) => o.kind === "rehash");
	for (const op of rehash.slice(0, sample)) {
		lines.push(`  # rehash ${op.slug}`);
	}
	if (rehash.length > sample) {
		lines.push(`  # … ${rehash.length - sample} more rehashes`);
	}
	for (const c of plan.conflicts) {
		lines.push(`  ! ${c.slug}: new hash held by event #${c.holder}`);
	}
	for (const a of plan.collisions) {
		lines.push(`  ? ${a.slug}: also attributed from ${a.towns.join(", ")}`);
	}
	return lines;
}

/** Plan, and write the plan when `apply`. Returns the plan either way. */
export async function repairVenueTowns(apply: boolean): Promise<RepairPlan> {
	const plan = await planRepair();
	if (apply && plan.ops.length > 0) await applyRepair(plan);
	return plan;
}

// Standalone execution: bun run src/scraper/repair-venue-towns.ts [--apply]
if (import.meta.main) {
	const args = process.argv.slice(2);
	const unknown = args.filter((a) => a !== "--apply" && a !== "--dry-run");
	if (unknown.length > 0) {
		console.error(`unknown argument(s): ${unknown.join(" ")}`);
		console.error(
			"usage: bun run src/scraper/repair-venue-towns.ts [--dry-run|--apply]",
		);
		process.exit(2);
	}
	const apply = args.includes("--apply") && !args.includes("--dry-run");
	const plan = await repairVenueTowns(apply);
	console.log(
		`repair-venue-towns (${apply ? "APPLIED" : "dry run — pass --apply to write"})`,
	);
	for (const line of describePlan(plan)) console.log(line);
}
