import type { Db } from "@events-tracker/db/client";

/**
 * Shared tRPC context (SLICE_8). The drizzle handle is injected by the caller
 * (the dev Hono server passes its server db) rather than imported as a module
 * singleton, so the router code stays free of dotenv/process.env.
 */
export type Context = {
	db: Db;
	auth: null;
	session: null;
};

/** Build a context from an injected db handle. */
export function createContext(db: Db): Context {
	return { db, auth: null, session: null };
}
