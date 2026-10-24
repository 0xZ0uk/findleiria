import { defineConfig } from "drizzle-kit";

// Env comes from the repo-root .env.schema: the db:* scripts run drizzle-kit
// through `varlock run`, which validates and injects the #db items.
export default defineConfig({
	schema: "./src/schema",
	out: "./src/migrations",
	dialect: "turso",
	dbCredentials: {
		url: process.env.DATABASE_URL || "",
		...(process.env.TURSO_AUTH_TOKEN
			? { authToken: process.env.TURSO_AUTH_TOKEN }
			: {}),
	},
});
