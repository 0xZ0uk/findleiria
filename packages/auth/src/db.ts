import { drizzle } from "drizzle-orm/libsql/web";
import { createClient } from "#libsql-client";

import { authEnv } from "./env.js";
import * as schema from "./schema.js";

/**
 * The auth database, on its own libSQL connection.
 *
 * Which client opens it is chosen by the `#libsql-client` import map in
 * package.json, not at runtime: Bun (tests, dev server) gets the Node client,
 * which can open `file:` databases; everything else, i.e. the Vercel functions,
 * gets the web client, so the native `libsql` binary is never traced into the
 * function bundle (a dynamic `import()` would not help: file tracing follows
 * literal specifiers). `drizzle-orm/libsql/web` is used for the same reason:
 * `drizzle-orm/libsql` imports `@libsql/client` itself. It only wraps the
 * client it is handed, so it works with either.
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
