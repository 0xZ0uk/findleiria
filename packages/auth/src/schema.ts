import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * better-auth's tables, hand-written to match the field set better-auth
 * 1.7.4 declares (`getAuthTables()` in `better-auth/db`):
 * user, session, account, verification, and rateLimit (database storage).
 *
 * TS keys stay camelCase because that is what the drizzle adapter looks up;
 * SQL columns are snake_case. Timestamps are epoch seconds (`timestamp` mode),
 * which is how better-auth reads and writes Dates.
 */

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" })
		.notNull()
		.default(false),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		token: text("token").notNull().unique(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {
			mode: "timestamp",
		}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {
			mode: "timestamp",
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [index("account_user_id_idx").on(table.userId)],
);

/**
 * A reader's saved event, keyed by user and event slug.
 *
 * Lives in the auth database on purpose: the events DB is mirrored to a Turso
 * token baked into the browser bundle, so user data can never land there. The
 * unique (user, slug) pair makes `saveEvent` idempotent — saving twice stays
 * one row — and the slug alone keeps the row hydratable after the event passes.
 */
export const savedEvent = sqliteTable(
	"saved_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		eventSlug: text("event_slug").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		uniqueIndex("saved_event_user_slug_idx").on(table.userId, table.eventSlug),
		index("saved_event_user_idx").on(table.userId),
	],
);

export const verification = sqliteTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

/**
 * better-auth's rate-limit counters (`rateLimit: { storage: "database" }`).
 *
 * Serverless instances share nothing in memory, so the counters live here: one
 * row per client-IP + path key. `lastRequest` is epoch MILLISECONDS as a plain
 * number (not a `timestamp` column) because better-auth compares it against
 * `Date.now()`; SQLite integers are 64-bit, so it fits.
 */
export const rateLimit = sqliteTable("rate_limit", {
	id: text("id").primaryKey(),
	key: text("key").notNull().unique(),
	count: integer("count").notNull(),
	lastRequest: integer("last_request").notNull(),
});
