import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import type * as schema from "./schema.js";

/**
 * The auth database handle, as the rest of the package sees it: the async
 * SQLite base both drivers extend (`drizzle-orm/d1` in the Worker,
 * `drizzle-orm/libsql` under Bun). Only what the two share is available, so a
 * driver-specific API (a libSQL `rowsAffected`, a D1 `meta`) cannot leak in and
 * work on one runtime only. The run result is `unknown` for the same reason.
 *
 * No `db.transaction()`: D1 rejects `BEGIN`/`COMMIT`, so a transaction would
 * pass on libSQL in the tests and then fail in production. Use `db.batch` or
 * one statement instead.
 */
export type AuthDb = BaseSQLiteDatabase<"async", unknown, typeof schema>;

/**
 * The contract of the `#auth-db` import map, and the module its `types`
 * condition resolves to. Type-only on purpose: the real implementations are
 * auth-db.workerd.ts (needs `cloudflare:workers`, so only the Worker's types
 * can see it) and auth-db.node.ts (needs `@libsql/client`); both annotate their
 * return type with `AuthDb`, so tsc checks each against this one signature
 * while packages that merely import `@events-tracker/auth` never load either.
 */
export declare function openAuthDb(dbSchema: typeof schema): AuthDb;
