/**
 * The five event themes and the pastel each one wears.
 *
 * The canonical taxonomy (`apps/server/src/scraper/categories.ts`) has over
 * twenty labels; twenty colours would mean none. They fold into five groups a
 * reader can tell apart at a glance, and every coloured mark still prints its
 * own label, so colour is never the only thing carrying the category. A label
 * with no group (`Outros`, or anything a source invents) stays neutral.
 */
export type ThemeGroup = "music" | "stage" | "arts" | "food" | "outdoors";

const GROUP_OF: Record<string, ThemeGroup> = {
	Música: "music",
	Concertos: "music",
	Festivais: "music",
	Clubbing: "music",
	Teatro: "stage",
	Dança: "stage",
	Comedy: "stage",
	Infantil: "stage",
	Cultura: "arts",
	Cinema: "arts",
	Literatura: "arts",
	"Museus & Exposições": "arts",
	Encontros: "arts",
	Conferências: "arts",
	Workshop: "arts",
	"Mercados e Feiras": "food",
	Gastronomia: "food",
	Tradição: "food",
	Festas: "outdoors",
	Natureza: "outdoors",
	"Atividades ao Ar Livre": "outdoors",
	Desporto: "outdoors",
};

export function themeOf(category: string): ThemeGroup | null {
	return GROUP_OF[category] ?? null;
}

/** An event's theme: its first category that belongs to a group. */
export function eventTheme(categories: readonly string[]): ThemeGroup | null {
	for (const category of categories) {
		const group = themeOf(category);
		if (group) return group;
	}
	return null;
}

/**
 * Pastel fill + its own dark ink, for tags and theme surfaces. Spelled out in
 * full so Tailwind sees every class. Each pair clears 6.4:1.
 */
export const THEME_TAG: Record<ThemeGroup, string> = {
	music: "bg-theme-music text-theme-music-foreground",
	stage: "bg-theme-stage text-theme-stage-foreground",
	arts: "bg-theme-arts text-theme-arts-foreground",
	food: "bg-theme-food text-theme-food-foreground",
	outdoors: "bg-theme-outdoors text-theme-outdoors-foreground",
};

/** The neutral tag for a category with no group. */
export const NEUTRAL_TAG = "border border-border bg-card text-muted-foreground";

/** A small solid dot in the theme's ink, for chips that carry a label. */
export const THEME_DOT: Record<ThemeGroup, string> = {
	music: "bg-theme-music-foreground",
	stage: "bg-theme-stage-foreground",
	arts: "bg-theme-arts-foreground",
	food: "bg-theme-food-foreground",
	outdoors: "bg-theme-outdoors-foreground",
};

/** The pastel surface alone, for a block that takes its event's theme. */
export const THEME_SURFACE: Record<ThemeGroup, string> = {
	music: "bg-theme-music",
	stage: "bg-theme-stage",
	arts: "bg-theme-arts",
	food: "bg-theme-food",
	outdoors: "bg-theme-outdoors",
};

export const THEME_INK: Record<ThemeGroup, string> = {
	music: "text-theme-music-foreground",
	stage: "text-theme-stage-foreground",
	arts: "text-theme-arts-foreground",
	food: "text-theme-food-foreground",
	outdoors: "text-theme-outdoors-foreground",
};
