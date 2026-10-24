import { describe, expect, it } from "bun:test";

import { MAX_BODY_BYTES, MAX_SLUG_LENGTH, trackRoutes } from "./track";

const URL_ = "https://findleiria.test/api/track";
const SELF = "https://findleiria.test";
const SLUG = "festa-da-sardinha-a1b2c3d4e5f6";

type Point = { blobs?: unknown[]; indexes?: unknown[] };

/** A fake ANALYTICS binding that records every data point written. */
function fakeEnv() {
	const points: Point[] = [];
	return {
		points,
		env: {
			ANALYTICS: { writeDataPoint: (p?: Point) => void points.push(p ?? {}) },
		},
	};
}

async function post(
	body: unknown,
	{ origin = SELF, raw }: { origin?: string | null; raw?: string } = {},
) {
	const { points, env } = fakeEnv();
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (origin) headers.origin = origin;
	const res = await trackRoutes.request(
		URL_,
		{ method: "POST", headers, body: raw ?? JSON.stringify(body) },
		env,
	);
	return { points, status: res.status };
}

describe("POST /api/track", () => {
	it("writes the data point and answers 204", async () => {
		const { points, status } = await post({
			name: "fonte",
			data: { slug: SLUG },
		});
		expect(status).toBe(204);
		expect(points).toEqual([
			{ blobs: ["fonte", SLUG, ""], indexes: ["fonte"] },
		]);
	});

	it("rejects event names off the allow-list", async () => {
		const { points, status } = await post({
			name: "other",
			data: { slug: SLUG },
		});
		expect(status).toBe(400);
		expect(points).toHaveLength(0);
	});

	it("rejects a missing, non-string or malformed slug", async () => {
		for (const data of [undefined, {}, { slug: 1 }, { slug: "Has Space" }]) {
			const { points, status } = await post({ name: "fonte", data });
			expect(status).toBe(400);
			expect(points).toHaveLength(0);
		}
	});

	it("rejects a slug over the length bound", async () => {
		const { points, status } = await post({
			name: "fonte",
			data: { slug: "a".repeat(MAX_SLUG_LENGTH + 1) },
		});
		expect(status).toBe(400);
		expect(points).toHaveLength(0);
	});

	it("rejects invalid JSON and non-object bodies", async () => {
		for (const raw of ["{nope", "null", "42", ""]) {
			const { points, status } = await post(null, { raw });
			expect(status).toBe(400);
			expect(points).toHaveLength(0);
		}
	});

	it("rejects a body over the cap with 413", async () => {
		const { points, status } = await post({
			name: "fonte",
			data: { slug: SLUG, pad: "x".repeat(MAX_BODY_BYTES) },
		});
		expect(status).toBe(413);
		expect(points).toHaveLength(0);
	});

	it("caps a streamed body that declares no Content-Length", async () => {
		const { env, points } = fakeEnv();
		const chunk = new TextEncoder().encode("x".repeat(MAX_BODY_BYTES));
		const res = await trackRoutes.request(
			URL_,
			{
				method: "POST",
				headers: { origin: SELF },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(chunk);
						controller.enqueue(chunk);
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit,
			env,
		);
		expect(res.status).toBe(413);
		expect(points).toHaveLength(0);
	});

	it("refuses a cross-origin request", async () => {
		const { points, status } = await post(
			{ name: "fonte", data: { slug: SLUG } },
			{ origin: "https://evil.example" },
		);
		expect(status).toBe(403);
		expect(points).toHaveLength(0);
	});

	it("refuses a request with no Origin header", async () => {
		const { points, status } = await post(
			{ name: "fonte", data: { slug: SLUG } },
			{ origin: null },
		);
		expect(status).toBe(403);
		expect(points).toHaveLength(0);
	});
});
