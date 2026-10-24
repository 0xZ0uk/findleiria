import { Hono } from "hono";

import { type Auth, auth } from "./auth.js";

/**
 * `/api/auth/*` as a Hono sub-app, shared by the Vercel function and the dev
 * server so both exercise the same handler. Everything better-auth exposes
 * (sign-up, sign-in, verify-email, Google callback, session, sign-out) hangs
 * off this prefix. Takes the instance so tests can mount one with a fake mailer.
 */
export function createAuthRoutes(instance: Auth = auth) {
	return new Hono().on(["GET", "POST"], "/api/auth/*", (c) =>
		instance.handler(c.req.raw),
	);
}

export const authRoutes = createAuthRoutes();
