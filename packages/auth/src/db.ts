import { openAuthDb } from "#auth-db";

import type { AuthDb } from "./auth-db.types.js";
import * as schema from "./schema.js";

export type { AuthDb };

/**
 * The auth database.
 *
 * Which driver opens it is chosen by the `#auth-db` import map in package.json,
 * not at runtime: the `workerd` condition (and `default`) gets D1 through the
 * `AUTH_DB` binding; `bun` (tests, dev server) gets a libSQL `file:` database.
 * Keeping the choice in the module graph means the Worker bundle never
 * contains the native libSQL client.
 *
 * Users and sessions never share a database with public events: the events
 * snapshot is published to the browser, so a shared DB would hand every
 * visitor a way to read emails.
 */
export function createAuthDb(): AuthDb {
	return openAuthDb(schema);
}

export const authDb = createAuthDb();
export { schema as authSchema };
