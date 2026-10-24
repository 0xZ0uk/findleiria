import { describe, expect, test } from "bun:test";

import { eventHref, isSameLocation, pathnameToRoute, savedHref } from "./route";

describe("pathnameToRoute", () => {
	test("root is the agenda", () => {
		expect(pathnameToRoute("/")).toEqual({ kind: "agenda" });
	});

	test("/guardados is the saved events page", () => {
		expect(pathnameToRoute("/guardados")).toEqual({ kind: "saved" });
		expect(pathnameToRoute("/guardados/")).toEqual({ kind: "saved" });
	});

	test("an event slug is an event route", () => {
		expect(pathnameToRoute("/evento/concerto-no-teatro")).toEqual({
			kind: "event",
			slug: "concerto-no-teatro",
		});
	});

	test("a trailing slash is tolerated", () => {
		expect(pathnameToRoute("/evento/concerto-no-teatro/")).toEqual({
			kind: "event",
			slug: "concerto-no-teatro",
		});
	});

	test("a percent-encoded slug is decoded", () => {
		expect(pathnameToRoute("/evento/fo%20bar")).toEqual({
			kind: "event",
			slug: "fo bar",
		});
	});

	test("a bare /evento is not found", () => {
		expect(pathnameToRoute("/evento")).toEqual({ kind: "notFound" });
		expect(pathnameToRoute("/evento/")).toEqual({ kind: "notFound" });
	});

	test("a nested path under /evento is not found", () => {
		expect(pathnameToRoute("/evento/a/b")).toEqual({ kind: "notFound" });
	});

	test("an unknown path is not found", () => {
		expect(pathnameToRoute("/sobre")).toEqual({ kind: "notFound" });
		expect(pathnameToRoute("/eventos")).toEqual({ kind: "notFound" });
	});

	test("an undecodable slug is not found rather than throwing", () => {
		expect(() => pathnameToRoute("/evento/%E0%A4%A")).not.toThrow();
		expect(pathnameToRoute("/evento/%E0%A4%A")).toEqual({
			kind: "notFound",
		});
	});
});

describe("eventHref", () => {
	test("wraps the slug in the event path", () => {
		expect(eventHref("concerto-no-teatro")).toBe("/evento/concerto-no-teatro");
	});

	test("encodes slugs that need it", () => {
		expect(eventHref("fo bar/concerto")).toBe("/evento/fo%20bar%2Fconcerto");
	});
});

describe("savedHref", () => {
	test("points at the saved events page", () => {
		expect(savedHref()).toBe("/guardados");
	});
});

describe("isSameLocation", () => {
	test("the page already showing is the same location", () => {
		expect(isSameLocation("/", "/", "")).toBe(true);
		expect(isSameLocation("/?concelho=Leiria", "/", "?concelho=Leiria")).toBe(
			true,
		);
	});

	test("the bare agenda link from a filtered agenda is a move", () => {
		expect(isSameLocation("/", "/", "?concelho=%C3%93bidos")).toBe(false);
	});

	test("a different path is a move", () => {
		expect(isSameLocation("/guardados", "/", "")).toBe(false);
	});
});
