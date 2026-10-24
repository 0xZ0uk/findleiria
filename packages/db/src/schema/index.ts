import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Venue — a physical location in Leiria where events happen.
 */
export const venues = sqliteTable(
	"venues",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		address: text("address"),
		lat: real("lat"),
		lng: real("lng"),
		city: text("city").notNull().default("Leiria"),
		/**
		 * What the record stands for on the ground, read off its own name by
		 * `scopeOfName` in @events-tracker/api. Sources that never named a
		 * venue file the event under the place: "Óbidos" carries every Óbidos
		 * listing nobody located, "Vieira de Leiria" every one in that vila.
		 * Only `venue` is a building you can walk into, so only `venue` may be
		 * drawn as a pin.
		 */
		scope: text("scope", { enum: ["venue", "lugar", "concelho"] })
			.notNull()
			.default("venue"),
	},
	(table) => [uniqueIndex("venues_slug_unique").on(table.slug)],
);

/**
 * Event — a single calendar event held at one of the venues.
 */
export const events = sqliteTable(
	"events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		title: text("title").notNull(),
		slug: text("slug").notNull().unique(),
		description: text("description"),
		/** Epoch seconds (UTC). */
		start_at: integer("start_at").notNull(),
		/** Epoch seconds (UTC). Nullable for events without a known end. */
		end_at: integer("end_at"),
		venue_id: integer("venue_id").references(() => venues.id),
		image_url: text("image_url"),
		url: text("url"),
		/** JSON-encoded string array of category names. */
		categories: text("categories", { mode: "json" }).$type<string[]>(),
		/**
		 * Raw date string from the source when no machine-readable date was
		 * parseable (e.g. RSS description text). Non-null ⇒ undated event:
		 * start_at holds the ingestion epoch as a placeholder and calendar
		 * views exclude the row.
		 */
		date_text: text("date_text"),
		/**
		 * Free entry: true = free, false = paid, null = unknown. Only set when a
		 * source says so (never guessed); ingest never lets a null overwrite a
		 * known value.
		 */
		is_free: integer("is_free", { mode: "boolean" }),
		/**
		 * Epoch seconds (UTC) when the event was hand-picked as a "week's pick".
		 * Non-null ⇒ curated pick. Set and cleared only by `src/feature.ts`;
		 * ingest and the scrapers never write it.
		 */
		featured_at: integer("featured_at"),
		/** Deduplication fingerprint (e.g. hash of source + source event id). */
		fingerprint: text("fingerprint").notNull().unique(),
		/** Epoch seconds (UTC). */
		created_at: integer("created_at")
			.notNull()
			.$defaultFn(() => Math.floor(Date.now() / 1000)),
		/** Epoch seconds (UTC), auto-updated on each write. */
		updated_at: integer("updated_at")
			.notNull()
			.$onUpdateFn(() => Math.floor(Date.now() / 1000)),
	},
	(table) => [
		uniqueIndex("events_slug_unique").on(table.slug),
		uniqueIndex("events_fingerprint_unique").on(table.fingerprint),
		index("events_start_at_idx").on(table.start_at),
		index("events_venue_id_idx").on(table.venue_id),
	],
);

/**
 * EventSource — provenance record mapping an event to an upstream source;
 * used for deduplication and first-seen tracking.
 */
export const eventSources = sqliteTable(
	"event_sources",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		event_id: integer("event_id")
			.notNull()
			.references(() => events.id, { onDelete: "cascade" }),
		source: text("source").notNull(),
		source_event_id: text("source_event_id"),
		source_url: text("source_url"),
		/** Epoch seconds (UTC) when this source first reported the event. */
		first_seen_at: integer("first_seen_at").notNull(),
		/**
		 * Epoch seconds (UTC) of the last ingest whose listing named this
		 * event (C5). Lets the scraper prune rows a full-listing source has
		 * stopped publishing (cancelled / moved). Null = never tracked, which
		 * is never pruned.
		 */
		last_seen_at: integer("last_seen_at"),
	},
	(table) => [
		uniqueIndex("event_sources_event_id_source_unique").on(
			table.event_id,
			table.source,
		),
		index("event_sources_source_source_event_id_idx").on(
			table.source,
			table.source_event_id,
		),
	],
);

/**
 * EventAlias — a source item whose row reconcile folded into another event
 * (C6). The keeper already carries an attribution from that source (one per
 * source per event), so the absorbed item's own attribution cannot move onto
 * it; without this record the next scrape no longer recognises the item,
 * re-inserts it and reconcile absorbs it again, every run. Ingest resolves
 * aliases before minting a row. Scraper bookkeeping only: never published to
 * Turso (see publish-turso.ts).
 */
export const eventAliases = sqliteTable(
	"event_aliases",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		source: text("source").notNull(),
		source_event_id: text("source_event_id").notNull(),
		/** The surviving (keeper) event the item now resolves to. */
		event_id: integer("event_id")
			.notNull()
			.references(() => events.id, { onDelete: "cascade" }),
		/** Epoch seconds (UTC) when the alias was recorded. */
		created_at: integer("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("event_aliases_source_item_event_unique").on(
			table.source,
			table.source_event_id,
			table.event_id,
		),
		index("event_aliases_event_id_idx").on(table.event_id),
	],
);

/**
 * ScrapeRun — one execution of a source scrape.
 */
export const scrapeRuns = sqliteTable(
	"scrape_runs",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		source: text("source").notNull(),
		/** Epoch seconds (UTC). */
		started_at: integer("started_at").notNull(),
		/** Epoch seconds (UTC). */
		finished_at: integer("finished_at"),
		items_found: integer("items_found").notNull().default(0),
		items_new: integer("items_new").notNull().default(0),
		items_failed: integer("items_failed").notNull().default(0),
		error: text("error"),
		/**
		 * Items the source's listing showed (pre-gate, already-seen ones
		 * included); null when the source does not report it. 0 on a source
		 * that normally lists dozens = broken parser, not a quiet day.
		 */
		items_discovered: integer("items_discovered"),
		/** Pages the scrape fetched; null when the source does not report it. */
		pages_fetched: integer("pages_fetched"),
		items_updated: integer("items_updated").notNull().default(0),
		/** Rows pruned because this full-listing source stopped listing them. */
		items_pruned: integer("items_pruned").notNull().default(0),
		/** Non-fatal notes, e.g. the prune circuit breaker refusing. */
		warnings: text("warnings"),
		/** The batch's post-pass (purge/venue merge/reconcile) failures. */
		postpass_error: text("postpass_error"),
	},
	(table) => [
		index("scrape_runs_source_started_at_idx").on(
			table.source,
			table.started_at,
		),
	],
);
