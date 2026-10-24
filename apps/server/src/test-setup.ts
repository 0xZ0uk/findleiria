/**
 * Bun test preload: runs once, before any test file imports `@events-tracker/db`.
 *
 * `bun test` does not go through `varlock run`, so no .env is loaded (and
 * bunfig.toml turns Bun's own .env loading off). Importing the scraper still
 * opens the events client at module load, so give it an in-memory database.
 * Always overwritten, never defaulted: a DATABASE_URL a developer or CI has
 * exported must not be reachable from the tests. Tests that need a database
 * build their own.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";
process.env.CORS_ORIGIN = "http://localhost:3300";
