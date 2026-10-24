/**
 * Bun test preload: runs once, before any test file imports `db.ts`.
 *
 * Tests migrate and write to the auth database, so they must never see the real
 * one. This always overwrites the environment (a developer or CI may have a
 * real AUTH_DATABASE_URL exported) with one throwaway `file:` database
 * shared by the whole run, migrated here once. Test files never create or
 * delete it: it is removed after the last test file.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

const dir = mkdtempSync(join(tmpdir(), "findleiria-auth-test-"));
// Once, after every test file (a preload hook is global), not per file.
afterAll(() => rmSync(dir, { recursive: true, force: true }));

process.env.NODE_ENV = "test";
process.env.AUTH_DATABASE_URL = `file:${join(dir, "auth.db")}`;
process.env.AUTH_TRUSTED_ORIGINS = "";
process.env.BETTER_AUTH_SECRET = "test-secret-long-enough-to-sign-cookies";
process.env.BETTER_AUTH_URL = "http://localhost:3300";
process.env.GOOGLE_CLIENT_ID = "google-client-id-test";
process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-test";
// No sender: the bun mailer transport only logs, nothing can be sent for real.
process.env.MAIL_FROM = "";

const { authDb } = await import("./db");
const { migrate } = await import("drizzle-orm/libsql/migrator");
// Tests always run on the libSQL file driver (`bun` condition of `#auth-db`);
// `AuthDb` is the driver-neutral base type, so the migrator needs the cast.
await migrate(authDb as unknown as LibSQLDatabase, {
	migrationsFolder: join(import.meta.dir, "migrations"),
});
