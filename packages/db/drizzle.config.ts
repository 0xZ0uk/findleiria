import { defineConfig } from "drizzle-kit";

// Env comes from the repo-root .env.schema: the db:* scripts run drizzle-kit
// through `varlock run`, which validates and injects the #db items.
// DATABASE_URL is a local `file:` SQLite database. drizzle-kit calls its
// libSQL-driver dialect "turso"; there is no Turso service involved. The
// migrations it generates are also what `db:migrate:remote` applies to D1.
export default defineConfig({
	schema: "./src/schema",
	out: "./src/migrations",
	dialect: "turso",
	dbCredentials: { url: process.env.DATABASE_URL || "" },
});
