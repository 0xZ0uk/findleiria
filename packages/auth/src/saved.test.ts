import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// The database (fresh, file:, already migrated) comes from the bun preload.
import { authDb as db } from "./db";
import { listSavedSlugs, saveEvent, unsaveEvent } from "./saved";
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
