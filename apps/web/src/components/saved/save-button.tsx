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
 * list. The active state is the reader's own choice, so it takes the primary
 * green, and the filled icon carries it too, so it never rests on colour alone.
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
	// In a row the label goes: a word repeated on every line competes with the
	// titles. The icon keeps its accessible name from `aria-label`, so the
	// icon-only shape still says what it does.
	const labelClass = layout === "row" ? "sr-only" : "";
	const name = isSaved ? "Remover dos guardados" : "Guardar evento";

	const sizeClass =
		layout === "detail"
			? "h-11 gap-2 px-4 text-[15px] sm:h-10"
			: "size-11 text-[13px]";

	const baseClass =
		"inline-flex shrink-0 items-center justify-center rounded-full font-medium focus-ring motion-safe:transition-colors";

	const stateClass =
		layout === "detail"
			? isSaved
				? "border border-primary bg-primary-surface text-primary hover:bg-primary-surface/70"
				: "border border-control bg-background text-foreground hover:bg-card"
			: isSaved
				? "text-primary hover:bg-primary-surface"
				: "text-muted-foreground hover:bg-card hover:text-primary";

	// Signed out, the control is a route to the session page, keeping wherever
	// the reader was so they land back here after signing in. The query string
	// rides along, or a filtered agenda would come back unfiltered; `signInHref`
	// still only accepts a same-origin path.
	if (!saved.signedIn) {
		const path =
			typeof window === "undefined"
				? "/"
				: `${window.location.pathname}${window.location.search}`;
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
					strokeWidth={1.75}
					className={layout === "row" ? "size-5 shrink-0" : "size-4 shrink-0"}
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
				strokeWidth={1.75}
				className={layout === "row" ? "size-5 shrink-0" : "size-4 shrink-0"}
				fill={isSaved ? "currentColor" : "none"}
			/>
			<span className={labelClass}>{text}</span>
		</button>
	);
}
