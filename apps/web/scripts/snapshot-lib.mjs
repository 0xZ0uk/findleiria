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
 * `{ buildSnapshot, writeSnapshot, createReadDb, createD1ReadDb }` from packages/api.
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
 * True on Cloudflare Workers Builds, which sets WORKERS_CI=1 in every build
 * (https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
 * Any other non-empty value counts too; "0" and "false" do not.
 */
export const isWorkersBuild = (env = process.env) =>
	Boolean(env.WORKERS_CI) && !/^(0|false)$/i.test(env.WORKERS_CI);

const D1_VARS = ["CLOUDFLARE_ACCOUNT_ID", "EVENTS_D1_ID", "D1_READ_API_TOKEN"];

/**
 * Where the production build reads the snapshot from, from the environment
 * (the Workers Builds env, or locally the repo-root .env files injected by
 * `varlock run`, see apps/web/package.json):
 *
 *  - `{ kind: "file", url }`: a `file:` SNAPSHOT_DATABASE_URL, a local SQLite
 *    file read through libSQL (a local build against local.db or a copy). An
 *    explicit local choice wins over D1, except on Workers Builds (see below).
 *  - `{ kind: "d1", accountId, databaseId, token }`: the events D1 database
 *    over the REST API, with the READ-ONLY token.
 *
 * Server-side names on purpose: nothing here may be prefixed VITE_, or Vite
 * would inline it into the bundle (the schema also marks the token
 * @sensitive, and the leak guard in prerender-events.mjs checks the bundle).
 * Anything else fails the build with a message saying what is missing.
 *
 * On Workers Builds (WORKERS_CI) D1 is the only source: a build there has no
 * local.db, and a `file:` URL left in its build env would silently ship a
 * stale or empty snapshot, so it is refused.
 */
export function buildSource(env = process.env) {
	const snapshotUrl = env.SNAPSHOT_DATABASE_URL;
	if (snapshotUrl && isWorkersBuild(env)) {
		throw new Error(
			"SNAPSHOT_DATABASE_URL is set on Workers Builds (WORKERS_CI): refusing a local snapshot source for a deployed build. " +
				`Remove it from the build variables; the build reads D1 (${D1_VARS.join(", ")}).`,
		);
	}
	if (snapshotUrl) {
		if (!isLocalUrl(snapshotUrl)) {
			throw new Error(
				"SNAPSHOT_DATABASE_URL must be a `file:` URL for the build. The production build reads D1: unset it and set " +
					`${D1_VARS.join(", ")}.`,
			);
		}
		return { kind: "file", url: snapshotUrl };
	}
	const missing = D1_VARS.filter((name) => !env[name]);
	if (missing.length === D1_VARS.length) {
		throw new Error(
			`Missing ${D1_VARS.join(", ")} (Workers Builds env, or the repo-root .env / .env.local). ` +
				"The build reads the events from D1 to write the static snapshot. " +
				"For a local build, set SNAPSHOT_DATABASE_URL=file:/abs/path/local.db instead.",
		);
	}
	if (missing.length > 0) {
		throw new Error(
			`Missing ${missing.join(", ")}: reading the events from D1 needs ${D1_VARS.join(", ")} ` +
				"(the token must be the READ-ONLY D1 one).",
		);
	}
	return {
		kind: "d1",
		accountId: env.CLOUDFLARE_ACCOUNT_ID,
		databaseId: env.EVENTS_D1_ID,
		token: env.D1_READ_API_TOKEN,
	};
}

/** Open the drizzle database a `buildSource()` names. */
export function openSnapshotDb(builder, source) {
	if (source.kind === "d1") {
		return builder.createD1ReadDb({
			accountId: source.accountId,
			databaseId: source.databaseId,
			token: source.token,
			...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
		});
	}
	return builder.createReadDb(source.url);
}

/** Release the handle: libSQL has a connection to close, D1 REST has none. */
export function closeSnapshotDb(db) {
	db.$client?.close();
}

/**
 * Strings that must never appear in a client chunk: the database's identity
 * and credential, the API host path they are used against, and any libSQL
 * client. Empty values are dropped (`includes("")` is always true).
 */
export function bundleNeedles(source) {
	const needles = ["libsql"];
	if (source.kind === "d1") {
		needles.push(
			source.databaseId,
			source.token,
			"api.cloudflare.com/client/v4/accounts",
		);
	}
	return needles.filter(Boolean);
}

/** The dev snapshot's database: SNAPSHOT_DATABASE_URL, else the repo's local.db. */
export function devDatabaseUrl() {
	return (
		process.env.SNAPSHOT_DATABASE_URL ||
		`file:${path.join(REPO_DIR, "local.db")}`
	);
}
