import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadDb, type Db, schema } from "@events-tracker/db/client";
import { migrate } from "drizzle-orm/libsql/migrator";

/**
 * Test-only: a throwaway libSQL file with the committed migrations applied, so
 * query tests run the real SQL instead of a stand-in. Not a `.test` file, so
 * `bun test` does not pick it up as a suite.
 */

const MIGRATIONS = path.resolve(import.meta.dir, "../../db/src/migrations");

export const DAY = 86_400;
/** A fixed clock: 2026-10-24 12:00 UTC. */
export const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
export const NOW = NOW_MS / 1000;

export type TestDb = { db: Db; path: string; cleanup: () => void };

export async function createTestDb(
	prefix = "findleiria-test-",
): Promise<TestDb> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, "test.db");
	const db = createReadDb(`file:${file}`);
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return {
		db,
		path: file,
		cleanup: () => {
			db.$client.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** An event row with sensible defaults; `extra` overrides any column. */
export function event(
	id: number,
	slug: string,
	start_at: number,
	extra: Partial<typeof schema.events.$inferInsert> = {},
): typeof schema.events.$inferInsert {
	return {
		id,
		slug,
		title: extra.title ?? `Evento ${slug}`,
		description: `Descrição de ${slug}`,
		start_at,
		venue_id: 1,
		categories: ["Música"],
		fingerprint: `fp-${slug}`,
		updated_at: NOW - DAY,
		...extra,
	};
}

/** Insert in chunks: SQLite caps the bound variables of one statement. */
export async function insertEvents(
	db: Db,
	rows: (typeof schema.events.$inferInsert)[],
	chunk = 200,
) {
	for (let i = 0; i < rows.length; i += chunk) {
		await db.insert(schema.events).values(rows.slice(i, i + chunk));
	}
}
