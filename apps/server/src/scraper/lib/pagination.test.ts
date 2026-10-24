import { describe, expect, test } from "bun:test";

import { lastPageFromHtml } from "./pagination";

describe("lastPageFromHtml", () => {
	test("takes the highest page number of the named parameter", () => {
		const html =
			'<a href="/x?events_list_13_page=2">2</a> <a href="/x?events_list_13_page=44&amp;paginating=true">44</a>';
		expect(lastPageFromHtml(html, "events_list_13_page")).toBe(44);
	});

	test("reads a bare page= link after ? or &", () => {
		expect(lastPageFromHtml('<a href="/a?q=1&page=6">', "page")).toBe(6);
	});

	test("ignores other parameters that merely end the same way", () => {
		expect(lastPageFromHtml('<a href="/a?other_page=9">', "page")).toBeNull();
	});

	test("null when the markup has no such link", () => {
		expect(lastPageFromHtml("<html></html>", "page")).toBeNull();
	});
});
