import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import * as schema from "./schema";

/**
 * Env-free db entry: the caller supplies the url and optional authToken.
 *
 * A libSQL handle: a local SQLite file (`file:…/local.db`, no token) for dev,
 * tests and the dev snapshot. The production build reads D1 instead, through
 * `createD1ReadDb` (./d1-read). The browser bundle never imports this,
 * because the SPA reads the static snapshot instead.
 */
export function createReadDb(url: string, authToken?: string) {
	const client = createClient({ url, authToken: authToken || undefined });
	return drizzle({ client, schema });
}

/**
 * What the query functions and the snapshot builder accept: the async SQLite
 * base both drivers extend (libSQL here, the D1 REST `sqlite-proxy` in
 * ./d1-read), like packages/auth's `AuthDb`. The run result is `unknown`, so a
 * driver-specific API cannot leak into a query and work on one source only.
 */
export type Db = BaseSQLiteDatabase<"async", unknown, typeof schema>;

export { createD1ReadDb, type D1ReadOptions } from "./d1-read";

export { schema };
