import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// The database (fresh, file:, already migrated) comes from the bun preload.
import { authDb as db } from "./db";
import {
	isValidSlug,
	listSavedSlugs,
	MAX_SAVED_PER_USER,
	saveEvent,
	unsaveEvent,
} from "./saved";
import { savedRoutes } from "./saved-routes";
import * as schema from "./schema";

async function createUser(id: string, email: string) {
	const now = new Date();
	await db.insert(schema.user).values({
		id,
		name: "Teste",
		email,
		emailVerified: false,
		createdAt: now,
		updatedAt: now,
	});
}

async function savedCount(userId: string): Promise<number> {
	const rows = await db
		.select({ id: schema.savedEvent.id })
		.from(schema.savedEvent)
		.where(eq(schema.savedEvent.userId, userId));
	return rows.length;
}

describe("saved events", () => {
	test("saveEvent twice stays one row (idempotent)", async () => {
		const userId = crypto.randomUUID();
		await createUser(userId, `${userId}@teste.pt`);

		try {
			await saveEvent(userId, "concerto-de-verao");
			await saveEvent(userId, "concerto-de-verao");

			expect(await savedCount(userId)).toBe(1);
			expect(await listSavedSlugs(userId)).toEqual(["concerto-de-verao"]);
		} finally {
			await db.delete(schema.user).where(eq(schema.user.id, userId));
		}
	});

	test("lists newest-saved first", async () => {
		const userId = crypto.randomUUID();
		await createUser(userId, `${userId}@teste.pt`);

		try {
			// Insert at distinct instants: `created_at` is epoch seconds, so three
			// back-to-back `saveEvent` calls can land in the same second and the
			// tie-break is undefined. Direct inserts make the ordering explicit.
			const base = Math.floor(Date.now() / 1000);
			await db.insert(schema.savedEvent).values([
				{
					id: crypto.randomUUID(),
					userId,
					eventSlug: "primeiro",
					createdAt: new Date(base * 1000),
				},
				{
					id: crypto.randomUUID(),
					userId,
					eventSlug: "segundo",
					createdAt: new Date((base + 1) * 1000),
				},
				{
					id: crypto.randomUUID(),
					userId,
					eventSlug: "terceiro",
					createdAt: new Date((base + 2) * 1000),
				},
			]);

			expect(await listSavedSlugs(userId)).toEqual([
				"terceiro",
				"segundo",
				"primeiro",
			]);
		} finally {
			await db.delete(schema.user).where(eq(schema.user.id, userId));
		}
	});

	test("unsaveEvent empties the list and is idempotent", async () => {
		const userId = crypto.randomUUID();
		await createUser(userId, `${userId}@teste.pt`);

		try {
			await saveEvent(userId, "concerto-de-verao");
			await unsaveEvent(userId, "concerto-de-verao");
			await unsaveEvent(userId, "concerto-de-verao");

			expect(await listSavedSlugs(userId)).toEqual([]);
			expect(await savedCount(userId)).toBe(0);
		} finally {
			await db.delete(schema.user).where(eq(schema.user.id, userId));
		}
	});

	test("deleting the user cascades their saved rows away", async () => {
		const userId = crypto.randomUUID();
		await createUser(userId, `${userId}@teste.pt`);
		await saveEvent(userId, "concerto-de-verao");

		await db.delete(schema.user).where(eq(schema.user.id, userId));

		expect(await savedCount(userId)).toBe(0);
	});
});

describe("saved event cap", () => {
	test("saveEvent refuses past MAX_SAVED_PER_USER, but re-saving stays ok", async () => {
		const userId = crypto.randomUUID();
		await createUser(userId, `${userId}@teste.pt`);

		try {
			const now = new Date();
			await db.insert(schema.savedEvent).values(
				Array.from({ length: MAX_SAVED_PER_USER }, (_, i) => ({
					id: crypto.randomUUID(),
					userId,
					eventSlug: `evento-${i}-abcdef123456`,
					createdAt: now,
				})),
			);

			expect(await saveEvent(userId, "um-a-mais-abcdef123456")).toBe("limit");
			expect(await savedCount(userId)).toBe(MAX_SAVED_PER_USER);

			// Already saved: an idempotent no-op, not a new row, so not refused.
			expect(await saveEvent(userId, "evento-0-abcdef123456")).toBe("saved");

			// Freeing a slot lets the next save through.
			await unsaveEvent(userId, "evento-0-abcdef123456");
			expect(await saveEvent(userId, "um-a-mais-abcdef123456")).toBe("saved");
			expect(await savedCount(userId)).toBe(MAX_SAVED_PER_USER);
		} finally {
			await db.delete(schema.user).where(eq(schema.user.id, userId));
		}
	});

	test("the cap is per user", async () => {
		const a = crypto.randomUUID();
		const b = crypto.randomUUID();
		await createUser(a, `${a}@teste.pt`);
		await createUser(b, `${b}@teste.pt`);

		try {
			expect(await saveEvent(a, "concerto-abcdef123456")).toBe("saved");
			expect(await saveEvent(b, "concerto-abcdef123456")).toBe("saved");
		} finally {
			await db.delete(schema.user).where(eq(schema.user.id, a));
			await db.delete(schema.user).where(eq(schema.user.id, b));
		}
	});
});

describe("isValidSlug", () => {
	test("accepts the shape ingest produces", () => {
		expect(isValidSlug("concerto-de-verao-0123456789ab")).toBe(true);
		expect(isValidSlug("evento-0123456789ab")).toBe(true);
		expect(isValidSlug("sao-joao-2026-0123456789ab")).toBe(true);
	});

	test("rejects other shapes and oversized slugs", () => {
		for (const bad of [
			"",
			"-leading-hyphen",
			"trailing-hyphen-",
			"double--hyphen",
			"Upper-Case",
			"has space",
			'quote"',
			"percent%",
			"under_score",
			"slash/slash",
			"<script>",
			"a".repeat(201),
		]) {
			expect(isValidSlug(bad)).toBe(false);
		}
		expect(isValidSlug("a".repeat(200))).toBe(true);
	});
});

describe("POST /api/saved guards", () => {
	const post = (headers: Record<string, string>, body = "{}") =>
		savedRoutes.request("/api/saved", { method: "POST", headers, body });
	const json = { "content-type": "application/json" };
	const trusted = "http://localhost:3300";

	test("rejects a write with no Origin", async () => {
		expect((await post(json)).status).toBe(403);
	});

	test("rejects a write from an untrusted Origin", async () => {
		const res = await post({ ...json, origin: "https://evil.example" });
		expect(res.status).toBe(403);
	});

	test("rejects a non-JSON content type, even from a trusted Origin", async () => {
		for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
			const res = await post({ "content-type": type, origin: trusted });
			expect(res.status).toBe(415);
		}
		expect((await post({ origin: trusted })).status).toBe(415);
	});

	test("lets a trusted JSON write through to the session check", async () => {
		const res = await post({ ...json, origin: trusted });
		expect(res.status).toBe(401);
	});

	test("accepts a JSON content type with a charset", async () => {
		const res = await post({
			"content-type": "application/json; charset=utf-8",
			origin: trusted,
		});
		expect(res.status).toBe(401);
	});

	test("a GET needs no Origin", async () => {
		const res = await savedRoutes.request("/api/saved");
		expect(res.status).toBe(401);
	});
});
