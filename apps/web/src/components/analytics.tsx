import { useEffect } from "react";

/**
 * Cookieless analytics, off unless configured.
 *
 * Page views come from Cloudflare Web Analytics; custom events go to the
 * Worker's `POST /api/track` (Workers Analytics Engine). The token is a
 * build-time env var: without it the app ships no third-party script and sends
 * no events, so local dev and any fork stay clean. Set VITE_CF_BEACON_TOKEN
 * (the site token from the Web Analytics dashboard) to turn it on: no
 * cookies, so no consent banner.
 */
const TOKEN = import.meta.env.VITE_CF_BEACON_TOKEN;

const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

export function Analytics() {
	useEffect(() => {
		if (!TOKEN) return;
		if (document.querySelector("script[data-cf-beacon]")) return;

		const script = document.createElement("script");
		script.type = "module";
		script.src = BEACON_SRC;
		script.dataset.cfBeacon = JSON.stringify({ token: TOKEN });
		document.head.append(script);
	}, []);

	return null;
}

/**
 * Fire-and-forget custom event: a no-op when analytics is not configured, so
 * call sites never need to check. The body goes as a JSON Blob so the Worker
 * sees `Content-Type: application/json` without a CORS preflight.
 */
export function track(name: string, data?: Record<string, unknown>) {
	if (!TOKEN || typeof navigator.sendBeacon !== "function") return;

	navigator.sendBeacon(
		"/api/track",
		new Blob([JSON.stringify({ name, data })], { type: "application/json" }),
	);
}
