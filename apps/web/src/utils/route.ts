/**
 * Client-side routing for the SPA: no router dependency, just a pathname →
 * route function and a slug → href helper. The agenda owns `/`, an event owns
 * `/evento/<slug>`, the sign-in page owns `/entrar`, and everything else is a
 * 404 rendered in-place.
 */

/** One of the real routes, or a miss. */
export type Route =
	| { kind: "agenda" }
	| { kind: "event"; slug: string }
	| { kind: "saved" }
	| { kind: "signin" }
	| { kind: "notFound" };

/** Internal link to an event's page. */
export function eventHref(slug: string): string {
	return `/evento/${encodeURIComponent(slug)}`;
}

/** Internal link to the page of events the reader saved. */
export function savedHref(): string {
	return "/guardados";
}

/** Internal link to the sign-in page, optionally back to where the reader was. */
export function signInHref(redirectTo?: string): string {
	if (!redirectTo?.startsWith("/") || redirectTo.startsWith("//"))
		return "/entrar";
	return `/entrar?redirect=${encodeURIComponent(redirectTo)}`;
}

/**
 * Resolve a location pathname to a route.
 *
 * `/` is the agenda. `/evento/<slug>` (leading slash optional) is an event,
 * the trailing slash tolerated. A bare `/evento`, a nested `/evento/a/b`, an
 * unknown path, and a slug that fails to decode all land on `notFound`.
 */
export function pathnameToRoute(pathname: string): Route {
	if (pathname === "/") return { kind: "agenda" };
	if (pathname === "/guardados" || pathname === "/guardados/")
		return { kind: "saved" };
	if (pathname === "/entrar" || pathname === "/entrar/")
		return { kind: "signin" };

	const match = /^\/evento\/([^/]+)\/?$/.exec(pathname);
	if (match) {
		try {
			return { kind: "event", slug: decodeURIComponent(match[1] ?? "") };
		} catch {
			return { kind: "notFound" };
		}
	}

	return { kind: "notFound" };
}

/** Fired after the app pushes a new location, since `pushState` emits nothing. */
export const LOCATION_CHANGE_EVENT = "locationchange";

/**
 * Whether following `href` would land on the page already showing.
 *
 * Pushing it anyway would add a history entry that goes nowhere, and would
 * overwrite the `from` state the current entry carries.
 */
export function isSameLocation(
	href: string,
	pathname: string,
	search: string,
): boolean {
	return href === `${pathname}${search}`;
}
