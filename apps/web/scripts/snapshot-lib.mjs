// Shared by the build-time prerender and the dev `snapshot` script: load the
// TypeScript snapshot builder from packages/api and open the database it reads.
// Plain Node ESM. The builder is TS that imports workspace packages without
// file extensions, so it is loaded through Vite's module runner (already a
// dependency) rather than a second TS toolchain.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(SCRIPT_DIR, "..");
export const REPO_DIR = path.resolve(APP_DIR, "../..");
const BUILDER = path.join(REPO_DIR, "packages/api/src/snapshot.ts");

/**
 * `{ buildSnapshot, writeSnapshot, createReadDb }` from packages/api.
 * Workspace packages are TS source, so they must be transformed, not handed
 * to Node as externals.
 */
export async function loadSnapshotBuilder() {
	const { module } = await runnerImport(BUILDER, {
		root: APP_DIR,
		logLevel: "error",
		environments: {
			inline: { resolve: { noExternal: [/^@events-tracker\//] } },
		},
	});
	return module;
}

export const isLocalUrl = (url) => url.startsWith("file:");

/**
 * The production build's database: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 * (read-only), from the environment: the Vercel project env, or locally the
 * repo-root .env files injected by `varlock run` (see apps/web/package.json).
 * Server-side names on purpose: nothing here may be prefixed VITE_, or Vite
 * would inline it into the bundle (the schema also marks both @sensitive). A
 * `file:` URL needs no token, which is how a local build runs.
 */
export function buildCredentials() {
	const url = process.env.TURSO_DATABASE_URL;
	const token = process.env.TURSO_AUTH_TOKEN;
	if (!url) {
		throw new Error(
			"Missing TURSO_DATABASE_URL (Vercel project env, or the repo-root .env / .env.local). " +
				"The build reads the events from it to write the static snapshot.",
		);
	}
	if (!isLocalUrl(url) && !token) {
		throw new Error(
			`Missing TURSO_AUTH_TOKEN for ${new URL(url).hostname}: a remote Turso database needs the read-only token.`,
		);
	}
	return { url, token: token || undefined };
}

/** The dev snapshot's database: SNAPSHOT_DATABASE_URL, else the repo's local.db. */
export function devDatabaseUrl() {
	return (
		process.env.SNAPSHOT_DATABASE_URL ||
		`file:${path.join(REPO_DIR, "local.db")}`
	);
}

/** Hostname of a remote database URL; null for a local file. */
export function remoteHost(url) {
	if (isLocalUrl(url)) return null;
	return new URL(url.replace(/^libsql:/, "https:")).hostname;
}
