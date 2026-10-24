import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

/**
 * Env-free db entry: the caller supplies the url and optional authToken.
 *
 * It backs the query functions' `Db` type and the build-time snapshot, which
 * reads a remote Turso database (`libsql://…` with the read-only token) or a
 * local SQLite file (`file:…/local.db`, no token). The browser bundle no
 * longer imports this, because the SPA reads the static snapshot instead.
 */
export function createReadDb(url: string, authToken?: string) {
	const client = createClient({ url, authToken: authToken || undefined });
	return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createReadDb>;

export { schema };
