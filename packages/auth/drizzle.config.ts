import { defineConfig } from "drizzle-kit";

// Env comes from the repo-root .env.schema: the db:* scripts run drizzle-kit
// through `varlock run`, which validates and injects the #auth items.
const url = process.env.AUTH_DATABASE_URL ?? "file:../../local-auth.db";

export default defineConfig({
	schema: "./src/schema.ts",
	out: "./src/migrations",
	dialect: "turso",
	dbCredentials: {
		url,
		...(process.env.AUTH_TURSO_TOKEN
			? { authToken: process.env.AUTH_TURSO_TOKEN }
			: {}),
	},
});
