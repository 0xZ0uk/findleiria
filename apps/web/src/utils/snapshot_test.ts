import { describe, expect, test } from "bun:test";

import { startOfLisbonDay } from "./format";
import {
	EMBEDDED_EVENT_ID,
	eventsInWindow,
	fetchSnapshotFile,
	readEmbeddedEvent,
	SnapshotError,
} from "./snapshot";

const DAY = 86_400;

/**
 * The cut the SQL used to make. The snapshot is built in the morning and read
 * all day and into the next one, so "today" has to be the reader's today.
 */
describe("eventsInWindow", () => {
	// Built on the 24th; read at 10:00 Lisbon on the 25th (WEST, UTC+1).
	const readerNowMs = Date.UTC(2026, 9, 25, 9, 0, 0);
	const from = startOfLisbonDay(readerNowMs);
	const to = from + 90 * DAY;
	const at = (iso: string) => Date.parse(iso) / 1000;

	const rows = [
		{ slug: "ontem-a-noite", startAt: at("2026-10-24T21:30:00Z") },
		// 00:30 Lisbon on the 25th: today's, even though it is 23:30 UTC the day before.
		{ slug: "madrugada", startAt: at("2026-10-24T23:30:00Z") },
		{ slug: "hoje-de-manha", startAt: at("2026-10-25T08:00:00Z") },
		{ slug: "amanha", startAt: at("2026-10-26T20:00:00Z") },
		{ slug: "no-limite", startAt: to },
		{ slug: "depois-da-janela", startAt: to + 1 },
	];

	test("drops what started before the reader's Lisbon midnight", () => {
		const slugs = eventsInWindow(rows, from, to).map((row) => row.slug);
		expect(slugs).not.toContain("ontem-a-noite");
		expect(slugs).toContain("madrugada");
	});

	test("keeps today's earlier shows: the floor is the day, not the clock", () => {
		expect(eventsInWindow(rows, from, to).map((row) => row.slug)).toContain(
			"hoje-de-manha",
		);
	});

	test("includes the far edge and stops after it", () => {
		const slugs = eventsInWindow(rows, from, to).map((row) => row.slug);
		expect(slugs).toContain("no-limite");
		expect(slugs).not.toContain("depois-da-janela");
	});

	test("keeps the snapshot's order", () => {
		expect(eventsInWindow(rows, from, to).map((row) => row.slug)).toEqual([
			"madrugada",
			"hoje-de-manha",
			"amanha",
			"no-limite",
		]);
	});
});

function docWith(text: string | null) {
	return {
		getElementById: (id: string) =>
			id === EMBEDDED_EVENT_ID && text !== null
				? ({ textContent: text } as HTMLElement)
				: null,
	};
}

describe("readEmbeddedEvent", () => {
	const event = { slug: "concerto", title: "Concerto", description: "…" };

	test("returns the embedded event for its own slug", () => {
		expect(
			readEmbeddedEvent("concerto", docWith(JSON.stringify(event))),
		).toMatchObject({ slug: "concerto" });
	});

	/** After a client-side hop the old page's tag is still in the head. */
	test("ignores an event embedded for another slug", () => {
		expect(
			readEmbeddedEvent("outro", docWith(JSON.stringify(event))),
		).toBeUndefined();
	});

	test("is undefined with no tag, or a broken one", () => {
		expect(readEmbeddedEvent("concerto", docWith(null))).toBeUndefined();
		expect(readEmbeddedEvent("concerto", docWith("{nope"))).toBeUndefined();
		expect(readEmbeddedEvent("concerto", undefined)).toBeUndefined();
	});
});

function respond(status: number, body: string, type = "application/json") {
	return (async () =>
		new Response(body, {
			status,
			headers: { "content-type": type },
		})) as unknown as typeof fetch;
}

describe("fetchSnapshotFile", () => {
	test("parses a JSON file", async () => {
		expect(
			await fetchSnapshotFile<{ a: number }>(
				"/data/x.json",
				respond(200, '{"a":1}'),
			),
		).toEqual({
			a: 1,
		});
	});

	test("is null for a file that is not there", async () => {
		expect(
			await fetchSnapshotFile(
				"/data/x.json",
				respond(404, "nope", "text/plain"),
			),
		).toBeNull();
	});

	/** An SPA fallback must never be read as an empty agenda. */
	test("refuses an HTML page served in place of the file", async () => {
		await expect(
			fetchSnapshotFile(
				"/data/x.json",
				respond(200, "<!doctype html>", "text/html"),
			),
		).rejects.toBeInstanceOf(SnapshotError);
	});

	test("throws on a server error", async () => {
		await expect(
			fetchSnapshotFile("/data/x.json", respond(500, "{}")),
		).rejects.toBeInstanceOf(SnapshotError);
	});
});
