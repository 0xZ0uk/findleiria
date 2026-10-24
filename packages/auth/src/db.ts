import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { authEnv } from "./env.js";
import * as schema from "./schema.js";

/**
 * The auth database, on its own libSQL connection.
 *
 * Users and sessions never share a database with public events: the events
 * token is baked into the browser bundle, so a shared DB would hand every
 * visitor a way to read emails.
 */
export function createAuthDb() {
	// Tests migrate and mutate whatever this points at. A real database in the
	// environment must never be reachable from `bun test` (see test-setup.ts).
	if (
		authEnv.NODE_ENV === "test" &&
		!authEnv.AUTH_DATABASE_URL.startsWith("file:")
	) {
		throw new Error(
			"Refusing to open a non-file: auth database under NODE_ENV=test.",
		);
	}

	const client = createClient({
		url: authEnv.AUTH_DATABASE_URL,
		authToken: authEnv.AUTH_TURSO_TOKEN,
	});

	return drizzle({ client, schema });
}

export const authDb = createAuthDb();
export { schema as authSchema };
