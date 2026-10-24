# FindLeiria design system

What the app actually ships. The tokens live in
`packages/ui/src/styles/globals.css` (primitives, semantic tokens, type roles)
and `apps/web/src/index.css` (font faces, the focus ring, `scrollbar-none`).
Shared shapes live in `apps/web/src/components/agenda/layout.ts`, and the
event-theme mapping in `apps/web/src/utils/themes.ts`. When this file and those
disagree, the code wins; fix this file.

The look is a light, boutique agenda: a white ground, **forest green
`#1f4a34`** for action and state, and **five pastels** that mark event themes.
Headings are Fraunces (serif), body and interface text is Inter. Corners are
soft (pills for controls, 12–20px for cards). There is one theme; there is no
dark mode.

## Colour

Primitives (`--fl-*` on `:root`) are named by hue and never used in a
component. Components read the semantic tokens below, through Tailwind
(`bg-primary`, `text-muted-foreground`, `bg-theme-music`, …).

| Semantic token | Primitive | Value | Use |
| --- | --- | --- | --- |
| `background` | white | `#ffffff` | page ground |
| `foreground` | ink-900 | `#17221b` | body and headings; the rule under section headings |
| `card`, `muted`, `secondary` | paper | `#fbfaf6` | the filter band, quiet cards, skeletons |
| `muted-foreground` | ink-600 | `#4f5b54` | secondary text (7.1:1 on white, 6.8:1 on paper) |
| `placeholder` | ink-500 | `#6b756f` | field placeholders (4.8:1) |
| `border` | ink-100 | `#e4e7e2` | hairlines: row rules, card edges |
| `control`, `input` | ink-400 | `#838c86` | a control's own edge (3.5:1 on white, 3.3:1 on paper) |
| `primary` | forest-800 | `#1f4a34` | the one filled action per view, selected state, links |
| `primary-foreground` | white | `#ffffff` | text on primary (10.1:1) |
| `primary-hover` | forest-900 | `#163a28` | hover on a primary fill |
| `primary-surface`, `accent` | forest-100 | `#d8efe0` | "today", quiet selected states (primary on it: 8.3:1) |
| `primary-foreground-muted` | forest-200 | `#cfe5d7` | secondary text on a primary fill (7.6:1) |
| `destructive` | red-700 | `#b42318` | errors (6.6:1) |
| `ring` | forest-800 | `#1f4a34` | focus ring |

### Event themes

The canonical categories fold into five groups (`utils/themes.ts`); a category
with no group (`Outros`) stays neutral. Each group is a pastel surface plus its
own dark ink.

| Group | Token | Surface | Ink | Ink on surface | Categories |
| --- | --- | --- | --- | --- | --- |
| music | `theme-music` | `#e7defe` lilac | `#43308a` | 8.0:1 | Música, Concertos, Festivais, Clubbing |
| stage | `theme-stage` | `#ffdbe5` pink | `#8a2747` | 6.7:1 | Teatro, Dança, Comedy, Infantil |
| arts | `theme-arts` | `#d3e8ff` sky | `#1f4c80` | 7.0:1 | Cultura, Cinema, Literatura, Museus & Exposições, Encontros, Conferências, Workshop |
| food | `theme-food` | `#ffe1c7` peach | `#7f3f12` | 6.4:1 | Mercados e Feiras, Gastronomia, Tradição |
| outdoors | `theme-outdoors` | `#fff0b3` butter | `#6b5200` | 6.5:1 | Festas, Natureza, Atividades ao Ar Livre, Desporto |

Rules the code follows:

- **Green means action or state, pastels mean theme.** No pastel is green, so
  "selected" and "a theme" never share a hue. A block that takes an event's
  theme (the week's pick) takes that event's pastel.
- **One filled button per view.** `PRIMARY_BUTTON` is the one fill; every other
  button is `BUTTON` (outline). Selected chips and the selected day fill green
  too, but they are state, not a competing action.
- **Colour is never alone.** Every theme tag prints its category, every theme
  dot sits next to its name, the active tab has a tinted pill behind its icon,
  and the saved bookmark fills as well as turning green.
- **Structure uses the hairline, controls use `control`.** A hairline sits near
  1.2:1 against the page; a control's boundary has to clear 3:1.
- **Poster-less events** get a seeded pastel mesh tile
  (`utils/mesh-gradient.ts`): three fields from the theme pastels over a light
  ground, anchored on the event's own theme, stable across renders and builds.
- **OG share cards** (`apps/web/scripts/og-card.mjs`) restate the tokens because
  satori reads no CSS: white ground, Fraunces title in ink, a `primary-surface`
  date pill, venue in `muted-foreground`, three pastel discs top right.

## Typography

Fonts are self-hosted from `apps/web/public/fonts` (latin subset, variable
woff2, licence in `OFL.txt`): Fraunces upright and italic (400–600) and Inter
(400–600). Inter and upright Fraunces are preloaded in `index.html`; the italic
loads on demand. Static WOFF copies for the OG card live in
`apps/web/assets/fonts` (satori cannot read woff2).

| Role | Family | Token |
| --- | --- | --- |
| Headings, titles, figures in blocks | Fraunces | `--font-serif` (`font-serif`) |
| Body, labels, controls, times | Inter | `--font-sans` (`font-sans`) |

Body is 16px / 1.6, antialiased on the root. The roles in `globals.css` pair
size, line-height and weight:

| Utility | Spec | Used for |
| --- | --- | --- |
| `type-display` | serif, `clamp(2.125rem, 4.6vw, 3.75rem)`, 400, 1.06, -0.025em | page `<h1>` (greeting, Guardados, sign-in) |
| `type-headline` | serif, `clamp(2rem, 4vw, 2.75rem)`, 400, 1.1, -0.02em | event title, 404 |
| `type-section` | serif, 1.625rem, 500, 1.2, -0.015em | day headings, block titles, error and empty headlines |
| `type-card` | serif, 1.1875rem, 500, 1.3, -0.005em | event titles in rows |
| `type-dek` | sans, 1.0625rem, 400, 1.6 | intro and description paragraphs |
| `type-label` | sans, 0.8125rem, 500, 1.4 | captions, field labels, counts; sentence case, never uppercase |
| `type-wordmark` | serif, 1.375rem, 600, -0.02em | the wordmark |

`CAPTION` and `LABEL` in `layout.ts` wrap `type-label`. The italic is for one
emphasised word in a display line (the week's count, "leiria" in the
wordmark). Times, counts and day numbers use `tabular-nums`; dates written out
in words do not.

## Shape

- Controls are pills: `BUTTON`, `PRIMARY_BUTTON`, `FIELD`, chips, the view
  switch and the nav segments are `rounded-full`.
- Cards and blocks: 20px for the fold's blocks and page cards, 16px (`rounded-2xl`)
  for the day strip, event aside and popovers, 12px (`rounded-xl`) for poster
  thumbnails. shadcn `--radius` is 12px.
- Theme tags (`TAG`): pill, 12px Inter 500, pastel surface + ink.
- Popovers carry the one shadow: `0 12px 32px -12px rgb(23 34 27 / .25)`.

## Layout and spacing

- `SHELL = "mx-auto w-full max-w-6xl px-5 sm:px-8 lg:px-12"`: one measure
  (72rem) and one gutter for the whole page. Each section of the agenda page
  sets its own shell so the filter band can run edge to edge.
- The agenda page, top to bottom: the **fold** (`fold.tsx`: date and last
  collection, greeting with the week's count, the 7-day strip, five blocks —
  the pick, tonight, by concelho, festas e ar livre, entrada livre), the
  **filter band** (paper, full width), then the **list** with a side column
  from `lg` (saved events, top types) or the **map**.
- The week is today plus six days, read from the unfiltered rows, so the fold
  never shifts while the reader filters. Every block is a shortcut into the
  same agenda (a day, a concelho, free entry, the map) and scrolls to it.
- The pick is the most recently curated event (`featuredAt`, set with the
  server's `feature` CLI); without one, the next event this week with a poster,
  music or stage first, captioned "Em destaque esta semana" instead of "Escolha
  da semana" so the page never claims an editor's choice it did not make.
- Section headings sit on a 1px `foreground` rule; rows are separated by
  hairlines.
- Spacing follows Tailwind's 4px grid.

## Touch targets

- Buttons, fields, icon buttons: `h-11` / `size-11` (44px) on phones, `sm:h-10`
  (40px) from `sm` where a pointer is expected. The row save button stays 44px.
- Text links smaller than that get `min-h-11` with offsetting negative margin.
- Fields are `text-base` (16px) on phones so iOS never zooms on focus.
- The bottom tab bar's tabs are 60px tall.

## Focus

`focus-ring` (`index.css`) is the only focus style: on `:focus-visible`, a solid
2px outline in `--ring` (forest green), 2px offset. Controls in `apps/web` carry
it.

Exception, deliberate: after a client-side navigation the app moves focus to the
new page's `<h1>` or `<main>` (`tabindex="-1"`, see `focusPage` in `app.tsx`) so
screen readers announce the page; those landmarks draw no ring.

## Motion policy

Motion is incidental and always opt-out-able:

- **Transitions are `motion-safe:`.** Colour, border and width transitions use
  `motion-safe:transition-*` (150 to 200ms), so they are absent under
  `prefers-reduced-motion: reduce`. Loading skeletons, including the map's, use
  `motion-safe:animate-pulse`.
- **Scrolling.** `html` scrolls smoothly only without a reduced-motion
  preference (`globals.css`), and the fold's shortcuts check the same media
  query before smooth-scrolling to the agenda.
- **The map** (`components/map`) disables its fill/stroke transition in CSS under
  `prefers-reduced-motion: reduce` and turns off Leaflet's `fadeAnimation` from
  `matchMedia`. Wheel-zoom is off so the map never hijacks page scroll.
- **Navigation** restores scroll on back/forward and resets to the top on a new
  page (`app.tsx`, `utils/scroll-state.ts`).

Known gap: the shadcn dropdown/menu primitives in `packages/ui` carry their own
`animate-in/out` classes (the web app does not use them).

## Do and don't

- Do take colours from the semantic tokens; never hard-code a colour in a
  component, and never use a `--fl-*` primitive outside `globals.css`.
- Do keep green for action and state, and pastels for themes.
- Do use `focus-ring`, `BUTTON`, `PRIMARY_BUTTON`, `FIELD`, `TAG`, `CAPTION`
  and the `type-*` roles rather than re-deriving them.
- Don't add a second filled button to a view, a sixth pastel, or a green pastel.
- Don't add a dark theme by inverting the tokens; it needs its own measured
  pairs.
- Don't change the type roles or tokens here without changing `globals.css` /
  `index.css` in the same commit.
