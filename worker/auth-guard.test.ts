import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createAuthGuard } from "./auth-guard";

const COMPLETE = {
	BETTER_AUTH_SECRET: "s".repeat(40),
	BETTER_AUTH_URL: "https://findleiria.example",
	GOOGLE_CLIENT_ID: "id",
	GOOGLE_CLIENT_SECRET: "client-secret-value",
	MAIL_FROM: "FindLeiria <no-reply@findleiria.example>",
};

function appWith(env: Record<string, string | undefined>) {
	const logs: string[] = [];
	const app = new Hono();
	app.use(
		"/api/*",
		createAuthGuard(
			() => env,
			(message) => void logs.push(message),
		),
	);
	app.all("/api/*", (c) => c.json({ ok: true }));
	return { app, logs };
}

describe("createAuthGuard", () => {
	test("passes requests through when the config is complete", async () => {
		const { app, logs } = appWith(COMPLETE);
		const res = await app.request("/api/saved");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"ok":true}');
		expect(logs).toEqual([]);
	});

	test("answers 500 with a generic body when a value is missing", async () => {
		const { app } = appWith({ ...COMPLETE, BETTER_AUTH_URL: undefined });
		for (const method of ["GET", "POST"]) {
			const res = await app.request("/api/auth/get-session", { method });
			expect(res.status).toBe(500);
			expect(await res.text()).toBe('{"error":"server_misconfigured"}');
		}
	});

	test("logs the missing names once, never the values", async () => {
		const { app, logs } = appWith({
			...COMPLETE,
			BETTER_AUTH_URL: undefined,
			MAIL_FROM: "",
		});
		await app.request("/api/saved");
		await app.request("/api/saved");
		await app.request("/api/auth/sign-in/email", { method: "POST" });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("BETTER_AUTH_URL, MAIL_FROM");
		expect(logs[0]).not.toContain(COMPLETE.GOOGLE_CLIENT_SECRET);
		expect(logs[0]).not.toContain(COMPLETE.BETTER_AUTH_SECRET);
	});

	test("re-reads the environment on every request", async () => {
		const env: Record<string, string | undefined> = { ...COMPLETE };
		delete env.GOOGLE_CLIENT_ID;
		const { app } = appWith(env);
		expect((await app.request("/api/saved")).status).toBe(500);
		env.GOOGLE_CLIENT_ID = "id";
		expect((await app.request("/api/saved")).status).toBe(200);
	});
});
