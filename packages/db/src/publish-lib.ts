import type { Database } from "bun:sqlite";

/**
 * Pure pieces of `publish-turso.ts`, split out so they can be tested without
 * a Turso connection (the script itself runs top-level side effects on import).
 */

/** An index as `sqlite_master` reports it. */
export type IndexInfo = { name: string; table: string };

/**
 * Every explicit index: `type = 'index'`, minus the `sqlite_autoindex_*` ones
 * SQLite creates on its own for PRIMARY KEY / UNIQUE column constraints (those
 * come with the table and need no migration of their own).
 */
export const INDEX_QUERY =
	"SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'";

/** Normalise a `sqlite_master` row from either driver into an `IndexInfo`. */
export function toIndexInfo(row: { name: unknown; tbl: unknown }): IndexInfo {
	return { name: String(row.name), table: String(row.tbl) };
}

/**
 * Local indexes on the mirrored `tables` that Turso does not have: the
 * "a migration added an index, Turso was never migrated" case. Matched by
 * name, since both sides are built from the same committed drizzle migrations.
 */
export function findMissingIndexes(
	local: readonly IndexInfo[],
	remote: readonly IndexInfo[],
	tables: readonly string[],
): IndexInfo[] {
	const remoteNames = new Set(remote.map((i) => i.name));
	return local.filter(
		(i) => tables.includes(i.table) && !remoteNames.has(i.name),
	);
}

/**
 * How long scrape_runs history is kept. The site reads only the latest run
 * (`eventStats`); the rest is operator forensics ("did a parser break last
 * week?"), for which a quarter is plenty. The publish mirrors the table to
 * Turso in full, so pruning locally keeps Turso bounded too.
 */
export const SCRAPE_RUNS_RETENTION_DAYS = 90;

/**
 * Delete `scrape_runs` rows older than the retention window, except each
 * source's most recent run: a source that went quiet for months must still
 * show when it last ran (and whether that run failed). Returns rows deleted.
 */
export function pruneScrapeRuns(
	db: Pick<Database, "run">,
	nowSeconds: number,
	retentionDays: number = SCRAPE_RUNS_RETENTION_DAYS,
): number {
	const cutoff = nowSeconds - retentionDays * 86_400;
	return db.run(
		`DELETE FROM scrape_runs
		 WHERE started_at < ?
		   AND id NOT IN (
		     SELECT id FROM (
		       SELECT id, ROW_NUMBER() OVER (
		         PARTITION BY source ORDER BY started_at DESC, id DESC
		       ) AS rn
		       FROM scrape_runs
		     ) WHERE rn = 1
		   )`,
		[cutoff],
	).changes;
}
