import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AuthDb } from "./auth-db.types.js";
import { authEnv } from "./env.js";
import type * as schema from "./schema.js";

/**
 * The auth database on a local libSQL `file:` database. Selected by the
 * `#auth-db` import map under Bun (tests and the dev server); the Worker never
 * loads this file, so `@libsql/client` and its native `libsql` binary stay out
 * of the Worker bundle.
 *
 * Dev/test only: production runs on D1 (see auth-db.workerd.ts).
 */
export function openAuthDb(dbSchema: typeof schema): AuthDb {
	const url = authEnv.AUTH_DATABASE_URL;
	if (!url) {
		throw new Error(
			"AUTH_DATABASE_URL is not set. Outside the Worker the auth database is a libSQL file (e.g. file:../../local-auth.db).",
		);
	}

	// Tests migrate and mutate whatever this points at. A real database in the
	// environment must never be reachable from `bun test` (see test-setup.ts).
	if (authEnv.NODE_ENV === "test" && !url.startsWith("file:")) {
		throw new Error(
			"Refusing to open a non-file: auth database under NODE_ENV=test.",
		);
	}

	const client = createClient({ url, authToken: authEnv.AUTH_TURSO_TOKEN });

	return drizzle({ client, schema: dbSchema });
}
