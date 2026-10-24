import { Bookmark } from "lucide-react";
import { signInHref } from "@/utils/route";
import { useSavedStore } from "./saved-context";

/**
 * Save / unsave one event.
 *
 * `row` is the compact control inside an agenda line (and the saved page's
 * rows); `detail` is the fuller button on the event's own page. Both are
 * ≥44px tall on phones. Signed out it is a plain link back to the sign-in page
 * — saving needs an account, so there is no silent failure and no local-only
 * list. The active state reads as the one amber mark next to the reader's own
 * choice, so "Guardado" sits in the page's primary colour.
 */
export function SaveButton({
	slug,
	layout,
}: {
	slug: string;
	layout: "row" | "detail";
}) {
	const saved = useSavedStore();
	const isSaved = saved.isSaved(slug);

	const text = isSaved ? "Guardado" : "Guardar";
	// In a row the label goes away below `sm`: at 320px the title needs the
	// width more than a repeated word does. The icon keeps its accessible name
	// from `aria-label`, so the icon-only shape still says what it does.
	const labelClass = layout === "row" ? "hidden sm:inline" : "";
	const name = isSaved ? "Remover dos guardados" : "Guardar evento";

	const sizeClass =
		layout === "detail"
			? "h-11 gap-2 px-4 text-[15px] sm:h-10"
			: "h-11 gap-1.5 px-2.5 text-[13px] sm:h-10";

	const baseClass =
		"inline-flex shrink-0 items-center justify-center rounded-[4px] font-medium focus-ring motion-safe:transition-colors";

	const stateClass = isSaved
		? layout === "detail"
			? "border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
			: "border border-primary/60 text-primary"
		: "border border-muted-foreground/60 bg-card text-foreground hover:border-primary/60 hover:text-primary";

	// Signed out, the control is a route to the session page, keeping wherever
	// the reader was so they land back here after signing in.
	if (!saved.signedIn) {
		const path = typeof window === "undefined" ? "/" : window.location.pathname;
		return (
			<a
				href={signInHref(path)}
				aria-label={layout === "row" ? "Guardar evento" : undefined}
				// A stable hook for the browser checks: the agenda's date-filter
				// chips also carry `aria-pressed`, so tests need something the
				// save control alone owns.
				data-slot="save"
				data-saved="false"
				data-save-slug={slug}
				className={`${baseClass} ${sizeClass} ${stateClass}`}
			>
				<Bookmark
					aria-hidden="true"
					strokeWidth={1.5}
					className="size-4 shrink-0"
				/>
				<span className={labelClass}>Guardar</span>
			</a>
		);
	}

	return (
		<button
			type="button"
			onClick={() => saved.toggle(slug)}
			aria-pressed={isSaved}
			aria-label={layout === "row" ? name : undefined}
			data-slot="save"
			data-saved={isSaved ? "true" : "false"}
			data-save-slug={slug}
			disabled={saved.isPendingSlug(slug) || !saved.ready}
			className={`${baseClass} ${sizeClass} ${stateClass} disabled:opacity-50`}
		>
			<Bookmark
				aria-hidden="true"
				strokeWidth={1.5}
				className="size-4 shrink-0"
				fill={isSaved ? "currentColor" : "none"}
			/>
			<span className={labelClass}>{text}</span>
		</button>
	);
}
