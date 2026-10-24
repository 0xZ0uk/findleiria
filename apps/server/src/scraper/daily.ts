/**
 * The ONE daily job (C10): every source → the post-passes once → publish to
 * D1 (packages/db `db:publish`, which also asks Workers Builds to rebuild) → a
 * summary. This is what cron runs:
 *
 *   pnpm --filter server daily
 *
 * Failure policy:
 *   - a failed source never stops the others (see `runSource`);
 *   - publish is SKIPPED when the batch failed hard: a post-pass threw (the
 *     database may be half-cleaned), or more than half of the sources failed
 *     (a network outage or a broken machine, and publishing would only push a
 *     staler copy over a good one). One or a few failed sources still publish:
 *     the rest of the district is fresh, and D1's copy of the failed
 *     source's events is no better than ours;
 *   - exit code 0 only when every source ran, the post-passes ran and the
 *     publish (with its redeploy) succeeded; 1 otherwise, so cron reports any
 *     failure — including the ones that were still published around.
 *   - `ALERT` lines (a listing that came back empty) are printed, but on their
 *     own do not fail the job.
 */
import { join } from "node:path";

import { sources } from "./index";
import { type BatchReport, parseConcurrency, runBatch } from "./runner";

export interface PublishDecision {
	publish: boolean;
	reason: string;
}

/** Whether a batch is good enough to publish (see the policy above). */
export function publishDecision(report: BatchReport): PublishDecision {
	if (report.postPasses.errors.length > 0) {
		return {
			publish: false,
			reason: `post-passes failed (${report.postPasses.errors.join("; ")})`,
		};
	}
	const failed = report.failedSources.length;
	const total = report.runs.length;
	if (total === 0 || failed * 2 > total) {
		return {
			publish: false,
			reason: `${failed} of ${total} sources failed (${report.failedSources.join(", ")})`,
		};
	}
	return {
		publish: true,
		reason:
			failed === 0
				? "every source ran"
				: `${failed} of ${total} sources failed (${report.failedSources.join(", ")}); publishing the rest`,
	};
}

/** Plain-text summary of the day: one line per source, then the totals. */
export function formatSummary(
	report: BatchReport,
	decision: PublishDecision,
	published: boolean | null,
): string {
	const lines = ["", "=== daily summary ==="];
	for (const r of report.runs) {
		const listed = r.discovered ?? "-";
		lines.push(
			`${r.status.padEnd(7)} ${r.source.padEnd(16)} new ${String(r.new).padStart(3)}  upd ${String(r.updated).padStart(3)}  found ${String(r.found).padStart(4)}  listed ${String(listed).padStart(4)}  failed ${String(r.failed).padStart(3)}  ${r.scrapeMs}+${r.ingestMs}ms${r.error ? `  ${r.error.slice(0, 120)}` : ""}`,
		);
	}
	const total = (pick: (r: BatchReport["runs"][number]) => number) =>
		report.runs.reduce((n, r) => n + pick(r), 0);
	const p = report.postPasses;
	lines.push(
		`totals: new ${total((r) => r.new)}, updated ${total((r) => r.updated)}, pruned ${total((r) => r.pruned)}; purged ${p.purged}, venues merged ${p.venuesMerged}, groups reconciled ${p.groupsReconciled} (post-passes ${p.timingsMs.purge}+${p.timingsMs.venueMerge}+${p.timingsMs.reconcile}ms); batch ${report.elapsedMs}ms`,
	);
	for (const alert of report.alerts) lines.push(alert);
	lines.push(
		published == null
			? `publish SKIPPED: ${decision.reason}`
			: published
				? `published to D1 (${decision.reason})`
				: `publish FAILED (${decision.reason})`,
	);
	return lines.join("\n");
}

/**
 * Run packages/db's `db:publish` (the D1 mirror + deploy hook). It runs
 * under its own `varlock run`, which loads the `#db` env (the Cloudflare
 * account, the events D1 id, the D1-edit token, the hook) that this process
 * is not given. Exit 0 means the swap committed and the hook was accepted.
 */
async function publish(): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		// A fresh varlock resolution for the child, not this process's.
		if (v !== undefined && !k.startsWith("__VARLOCK")) env[k] = v;
	}
	const child = Bun.spawn(["bun", "run", "db:publish"], {
		cwd: join(import.meta.dir, "../../../../packages/db"),
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	return (await child.exited) === 0;
}

if (import.meta.main) {
	const report = await runBatch(Object.entries(sources), {
		concurrency: parseConcurrency(process.env.SCRAPE_CONCURRENCY),
	});
	const decision = publishDecision(report);
	const published = decision.publish ? await publish() : null;
	console.log(formatSummary(report, decision, published));
	process.exit(report.ok && published === true ? 0 : 1);
}
