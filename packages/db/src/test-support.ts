import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The committed drizzle migrations, the same files D1 applies. */
export const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** Split one drizzle migration file into its statements. */
export function migrationStatements(file: string): string[] {
	return readFileSync(join(MIGRATIONS_DIR, file), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * An in-memory SQLite with every committed migration applied: the
 * schema both local.db and D1 end up with. `foreignKeys` turns on enforcement
 * the way D1 always has it.
 */
export function migratedDb(options: { foreignKeys?: boolean } = {}): Database {
	const db = new Database(":memory:");
	if (options.foreignKeys) db.run("PRAGMA foreign_keys = ON");
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const file of files) {
		for (const statement of migrationStatements(file)) db.run(statement);
	}
	return db;
}
