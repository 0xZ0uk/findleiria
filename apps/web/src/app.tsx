import { QueryClientProvider } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Announcements } from "@/components/agenda/announcements";
import { PageFooter } from "@/components/agenda/footer";
import { SHELL } from "@/components/agenda/layout";
import { AgendaPage } from "@/components/agenda/page";
import { Analytics } from "@/components/analytics";
import { SignInPage } from "@/components/auth/sign-in-page";
import { ErrorBoundary } from "@/components/error-boundary";
import { EventPage } from "@/components/event/event-page";
import { EventNotFound } from "@/components/event/not-found";
import { AppChrome } from "@/components/nav/chrome";
import { SavedProvider } from "@/components/saved/saved-context";
import { SavedPage } from "@/components/saved/saved-page";
import { useAgenda } from "@/hooks/use-agenda";
import {
	DEFAULT_TITLE,
	SHELL_DESCRIPTION,
	useDocumentMeta,
} from "@/hooks/use-document-meta";
import { queryClient } from "@/utils/api";
import {
	isSameLocation,
	LOCATION_CHANGE_EVENT,
	pathnameToRoute,
} from "@/utils/route";
import { scrollOf, withScroll } from "@/utils/scroll-state";

/** How the last pathname change happened, read once the new page has rendered. */
type Arrival = { kind: "push" } | { kind: "pop"; scrollY: number | null };

/**
 * Move focus to the new page, so a screen reader announces it instead of
 * staying on the link that just unmounted. The page's own heading when it has
 * one, otherwise `<main>`. `tabIndex=-1` makes either focusable without adding
 * a tab stop; index.css keeps the programmatic focus from drawing an outline.
 */
function focusPage() {
	const target =
		document.querySelector<HTMLElement>("h1") ??
		document.querySelector<HTMLElement>("main");
	if (!target) return;
	target.tabIndex = -1;
	target.focus({ preventScroll: true });
}

/**
 * Put the page back where it was left. The agenda comes straight from the
 * react-query cache, but a tall page can still be mid-layout on the first
 * frame, so retry for a short while until the position holds.
 */
function restoreScroll(y: number) {
	let frames = 0;
	const attempt = () => {
		window.scrollTo(0, y);
		if (Math.abs(window.scrollY - y) > 2 && frames++ < 30)
			requestAnimationFrame(attempt);
	};
	attempt();
}

/** Sits inside the provider: `useAgenda` needs the query client above it. */
function AgendaShell() {
	const agenda = useAgenda();
	// Coming back from an event would otherwise keep that event's title.
	useDocumentMeta(DEFAULT_TITLE, SHELL_DESCRIPTION);

	return (
		<div className="min-h-svh">
			<main>
				<AgendaPage agenda={agenda} />
				<div className={SHELL}>
					<Announcements agenda={agenda} />
				</div>
			</main>
			<div className={SHELL}>
				<PageFooter />
			</div>
		</div>
	);
}

/**
 * One pathname instead of a router dependency.
 *
 * Event pages are prerendered to real files by the build step, so a cold load
 * is crawlable without JS; this only takes over once the app is running.
 * Clicks are intercepted so a trip into an event and back does not reload the
 * document — which keeps the agenda's query cache alive and, because the
 * filters live in `location.search`, worth returning to.
 */
function usePathname(arrival: RefObject<Arrival | null>): string {
	const [pathname, setPathname] = useState(() => window.location.pathname);

	useEffect(() => {
		const sync = () => setPathname(window.location.pathname);

		const onPopState = () => {
			// The entry we are returning to carries the position saved when it was
			// left; a fresh push never does, so those always start at the top.
			arrival.current = {
				kind: "pop",
				scrollY: scrollOf(window.history.state),
			};
			sync();
		};

		const onClick = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
				return;

			const anchor = (event.target as Element | null)?.closest("a");
			const href = anchor?.getAttribute("href");
			if (
				!anchor ||
				!href?.startsWith("/") ||
				anchor.target === "_blank" ||
				anchor.hasAttribute("download")
			)
				return;

			event.preventDefault();
			const { pathname, search } = window.location;
			if (isSameLocation(href, pathname, search)) {
				window.scrollTo(0, 0);
				return;
			}
			// Remember where this entry was scrolled to, so Back can return to it.
			// Merged into the existing state so a `from` it carries survives.
			window.history.replaceState(
				withScroll(window.history.state, window.scrollY),
				"",
			);
			arrival.current = { kind: "push" };
			// Where we came from, so an event page can offer the way back to the
			// same filtered agenda instead of a bare home link.
			window.history.pushState({ from: pathname + search }, "", href);
			sync();
			// `pushState` fires no event, so tell whoever keeps state derived from
			// the URL (the agenda's filters) that it moved. Same pathname means no
			// remount, so without this they would keep showing the old query.
			window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
			window.scrollTo(0, 0);
		};

		window.addEventListener("popstate", onPopState);
		document.addEventListener("click", onClick);
		return () => {
			window.removeEventListener("popstate", onPopState);
			document.removeEventListener("click", onClick);
		};
	}, [arrival]);

	return pathname;
}

function Routes() {
	const arrival = useRef<Arrival | null>(null);
	const pathname = usePathname(arrival);
	const route = pathnameToRoute(pathname);

	// Manual, because the browser restores before the new page has rendered and
	// lands on whatever height the old one had. Pops are restored below.
	useEffect(() => {
		window.history.scrollRestoration = "manual";
	}, []);

	// After the new page has committed: focus it, and on Back/Forward put the
	// scroll position back. The first run is the initial load, not a navigation.
	const shown = useRef(pathname);
	useEffect(() => {
		if (shown.current === pathname) return;
		shown.current = pathname;
		const how = arrival.current;
		arrival.current = null;
		focusPage();
		if (how?.kind === "pop") restoreScroll(how.scrollY ?? 0);
	}, [pathname]);

	const page =
		route.kind === "signin" ? (
			<SignInPage />
		) : route.kind === "event" ? (
			<EventPage slug={route.slug} />
		) : route.kind === "saved" ? (
			<SavedPage />
		) : route.kind === "notFound" ? (
			<EventNotFound />
		) : (
			<AgendaShell />
		);

	// `/entrar` is a focused, single-purpose screen with its own wordmark row,
	// so it is the one route that keeps its own chrome.
	if (route.kind === "signin") return page;

	return (
		<>
			<AppChrome />
			{/* The phone tab bar is fixed, so the page carries its height. */}
			<SavedProvider>
				<div className="pb-24 sm:pb-0">{page}</div>
			</SavedProvider>
		</>
	);
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<ErrorBoundary title="A página não carregou.">
				<Routes />
			</ErrorBoundary>
			<Analytics />
		</QueryClientProvider>
	);
}
