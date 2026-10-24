// Dev snapshot: write the static JSON the SPA reads into apps/web/public/data/
// (gitignored), from the local SQLite database. `pnpm dev` runs it before Vite;
// re-run it after a scrape to see new events:
//
//   pnpm --filter web snapshot
//   SNAPSHOT_DATABASE_URL=file:/elsewhere.db pnpm --filter web snapshot
//
// With --soft (what `dev` passes) a missing or unmigrated database is a warning,
// not a failure, so the dev server still starts on a fresh clone.

import fs from "node:fs";
import path from "node:path";
import {
	APP_DIR,
	closeSnapshotDb,
	devDatabaseUrl,
	isLocalUrl,
	loadSnapshotBuilder,
} from "./snapshot-lib.mjs";

const soft = process.argv.includes("--soft");
const OUT = path.join(APP_DIR, "public", "data");

async function main() {
	const url = devDatabaseUrl();
	if (isLocalUrl(url) && !fs.existsSync(url.replace(/^file:/, ""))) {
		throw new Error(
			`${url} does not exist. Create it with \`cd packages/db && bun run db:migrate:deploy\`.`,
		);
	}
	const { buildSnapshot, writeSnapshot, createReadDb } =
		await loadSnapshotBuilder();
	const db = createReadDb(url);
	try {
		const snapshot = await buildSnapshot(db);
		const written = writeSnapshot(OUT, snapshot);
		console.log(
			`[snapshot] ${snapshot.agenda.events.length} agenda rows, ${snapshot.agenda.undated.length} undated, ` +
				`${snapshot.events.length} event files → ${path.relative(process.cwd(), OUT) || OUT} ` +
				`(${(written.bytes / 1024).toFixed(0)} KB)`,
		);
	} finally {
		closeSnapshotDb(db);
	}
}

main().catch((err) => {
	if (soft) {
		console.warn(
			`[snapshot] skipped (the agenda reports it is unpublished until this runs): ${err.message ?? err}`,
		);
		process.exit(0);
	}
	console.error("[snapshot] FAIL:", err);
	process.exit(1);
});
