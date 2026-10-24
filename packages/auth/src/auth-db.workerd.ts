import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import type { AuthDb } from "./auth-db.types.js";
import type * as schema from "./schema.js";

/**
 * The auth database on Cloudflare D1, through the `AUTH_DB` binding
 * (`wrangler.jsonc`, database `findleiria-auth`). Selected by the `#auth-db`
 * import map for the `workerd` condition, and it is also the map's `default`.
 *
 * Why it is the default: the only thing that loads the built package is the
 * Worker. Anywhere else (plain Node, an unknown bundler) `cloudflare:workers`
 * does not resolve, so the import fails loudly at load time instead of
 * silently opening some other database. Bun opts out explicitly through the
 * `bun` condition.
 */
export function openAuthDb(dbSchema: typeof schema): AuthDb {
	return drizzle(env.AUTH_DB, { schema: dbSchema });
}
