import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Announcements } from "@/components/agenda/announcements";
import { PageFooter } from "@/components/agenda/footer";
import { SHELL } from "@/components/agenda/layout";
import { AgendaPage } from "@/components/agenda/page";
import { Analytics } from "@/components/analytics";
import { SignInPage } from "@/components/auth/sign-in-page";
import { EventPage } from "@/components/event/event-page";
import { EventNotFound } from "@/components/event/not-found";
import { AppChrome } from "@/components/nav/chrome";
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

/** Sits inside the provider: `useAgenda` needs the query client above it. */
function AgendaShell() {
	const agenda = useAgenda();
	// Coming back from an event would otherwise keep that event's title.
	useDocumentMeta(DEFAULT_TITLE, SHELL_DESCRIPTION);

	return (
		<div className="min-h-svh">
			<main className={SHELL}>
				<AgendaPage agenda={agenda} />
				<Announcements agenda={agenda} />
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
function usePathname(): string {
	const [pathname, setPathname] = useState(() => window.location.pathname);

	useEffect(() => {
		const sync = () => setPathname(window.location.pathname);

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

		window.addEventListener("popstate", sync);
		document.addEventListener("click", onClick);
		return () => {
			window.removeEventListener("popstate", sync);
			document.removeEventListener("click", onClick);
		};
	}, []);

	return pathname;
}

function Routes() {
	const route = pathnameToRoute(usePathname());

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
			<div className="pb-24 sm:pb-0">{page}</div>
		</>
	);
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<Routes />
			<Analytics />
		</QueryClientProvider>
	);
}
