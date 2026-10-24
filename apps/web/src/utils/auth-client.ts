import { createAuthClient } from "better-auth/react";

/**
 * Same-origin by construction.
 *
 * No `baseURL`, so the client talks to `/api/auth` on whatever origin served
 * the page: Vite proxies that to the dev server, and in production the same
 * Worker that serves the SPA answers it. Pointing it at a separate API domain would
 * make the session cookie third-party, which Safari refuses — and most of our
 * readers arrive on an iPhone.
 */
export const authClient = createAuthClient();

export const { sendVerificationEmail, signIn, signOut, signUp, useSession } =
	authClient;
