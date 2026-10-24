/** One horizontal measure and one gutter for the whole page. */
export const SHELL = "mx-auto w-full max-w-6xl px-5 sm:px-8 lg:px-12";

/** The neutral pill button: outline in the control tone, no fill. */
export const BUTTON =
	"inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-control bg-background px-5 text-[15px] font-medium text-foreground focus-ring motion-safe:transition-colors hover:bg-card disabled:opacity-50 sm:h-10";

/**
 * The filled pill, for the one primary action in a view. Every other button
 * stays `BUTTON`: two filled buttons side by side read as two primaries.
 */
export const PRIMARY_BUTTON =
	"inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 text-[15px] font-medium text-primary-foreground focus-ring motion-safe:transition-colors hover:bg-primary-hover disabled:opacity-50";

/** The small caption: stat labels, counts, meta. Sentence case, Inter 13px. */
export const CAPTION = "type-label";

/**
 * The one field shape: select, date input, search.
 *
 * The border is the `control` token (3.5:1 on white) rather than the hairline:
 * a hairline sits near 1.2:1 against the page, and a control's own boundary
 * has to clear 3:1 to be findable. Structure (rules, cards) keeps the hairline.
 * The placeholder is its own token at 4.8:1.
 * 16px on phones so iOS never zooms the page when a field takes focus.
 */
export const FIELD =
	"h-11 w-full rounded-full border border-control bg-background px-4 text-base text-foreground focus-ring motion-safe:transition-colors placeholder:text-placeholder hover:border-foreground/60 sm:h-10 sm:text-[15px]";

export const LABEL = "type-label block pb-1.5 text-muted-foreground";

/** A theme or meta tag: a pill whose colours the caller supplies. */
export const TAG =
	"inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-none";
