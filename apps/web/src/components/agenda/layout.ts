/**
 * One horizontal measure and one gutter for the whole page.
 *
 * `GUTTER` is the negative-margin trick the sticky day headers need: they sit
 * inside the shell but have to paint edge to edge, so the inset has to be
 * expressed as a matching negative margin. Keeping both strings here is what
 * stops the header's bleed from drifting away from the shell's padding.
 */
export const SHELL = "mx-auto w-full max-w-5xl px-5 sm:px-8";

export const GUTTER = "-mx-5 px-5 sm:-mx-8 sm:px-8";

/** Shared shape for the three buttons on the page. */
export const BUTTON =
	"inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[4px] border border-control bg-card px-4 text-[15px] font-medium text-foreground focus-ring motion-safe:transition-colors hover:border-primary/60 hover:text-primary disabled:opacity-50 sm:h-10";

/** The small uppercase mono label: stat captions, chips, counts, meta. */
export const MICRO =
	"font-mono text-[11px] font-medium uppercase leading-[1.4] tracking-[0.14em]";

/**
 * The one field shape: select, date input, search.
 *
 * The border is the `control` token (index.css) rather than the `hairline`:
 * a hairline sits at 1.4:1 against the canvas, and a control's own boundary
 * has to clear 3:1 to be findable. Structure (rules, chips) keeps the hairline.
 * Measured on the card / on the page: dark 3.4:1 / 3.4:1 (muted-foreground at
 * 60%), light 3.6:1 / 3.7:1 (ink at 70%). Placeholder and other small muted
 * text use muted-foreground at 85%: at least 5.1:1 in both modes.
 * 16px on phones so iOS never zooms the page when a field takes focus.
 */
export const FIELD =
	"h-11 w-full rounded-[4px] border border-control bg-card px-3 text-base text-foreground focus-ring motion-safe:transition-colors placeholder:text-muted-foreground/85 hover:border-muted-foreground sm:h-10 sm:text-[15px]";

export const LABEL = "micro block pb-1.5 text-muted-foreground";
