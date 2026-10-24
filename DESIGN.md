# FindLeiria design system

What the app actually ships. The tokens live in
`packages/ui/src/styles/globals.css` (palette, radii, spacing, type utilities,
the shadcn token map) and `apps/web/src/index.css` (the `micro` label, the
focus ring, the theme variant). Layout constants live in
`apps/web/src/components/agenda/layout.ts`. When this file and those disagree,
the code wins; fix this file.

The look is dark-first, near-black and white-ish ink, with **one chromatic
colour: amber `#ff8c00`**. Corners are sharp (0 to 4px). Display type is
Schibsted Grotesk, body is Karla, labels are JetBrains Mono.

## Colour

Raw palette (`--p443-*` custom properties on `:root`):

| Token | Value | Use |
| --- | --- | --- |
| `--p443-primary` | `#ff8c00` | amber: links, active state, primary fills, focus ring |
| `--p443-on-primary` | `#1a1a1a` | text on amber fills |
| `--p443-primary-hover` | `#ffa133` | amber hover |
| `--p443-canvas` | `#0a0a0a` | dark page ground (default) |
| `--p443-surface` | `#141414` | cards, popovers, inputs, skeletons |
| `--p443-ink` | `#e5e5e5` | body and headings on dark |
| `--p443-ink-muted` | `#a3a3a3` | secondary text on dark |
| `--p443-hairline` | `#2a2a2a` | borders and rules on dark |
| `--p443-light-canvas` | `#ffffff` | light page ground |
| `--p443-light-surface` | `#fafafa` | light cards, popovers |
| `--p443-light-ink` | `#1a1a1a` | text on light |
| `--p443-light-ink-muted` | `#525252` | secondary text on light |

Components read the shadcn semantic tokens, never the raw palette:

| Semantic token | Dark (default) | Light |
| --- | --- | --- |
| `background` | canvas `#0a0a0a` | `#ffffff` |
| `foreground` | ink `#e5e5e5` | `#1a1a1a` |
| `card`, `popover`, `secondary`, `muted`, `accent` | surface `#141414` | `#fafafa` (`accent` is not overridden: stays `#141414`) |
| `card-foreground`, `popover-foreground`, `accent-foreground` | ink | `#1a1a1a` (`accent-foreground` stays ink) |
| `secondary-foreground`, `muted-foreground` | `#a3a3a3` | `#525252` |
| `primary` | `#ff8c00` | `#ff8c00` (same) |
| `primary-foreground` | `#1a1a1a` | `#1a1a1a` (same) |
| `destructive` | `#d0342c` | `#d0342c` (same) |
| `border` | `#2a2a2a` | `rgba(26, 26, 26, 0.12)` |
| `input` | `#2a2a2a` | `rgba(26, 26, 26, 0.16)` |
| `ring` | `#ff8c00` | `#ff8c00` |

Rules the code follows:

- **Theme is a class on `<html>`**: `dark` or `light`. `index.html` sets it
  before first paint from `localStorage` (`findleiria-theme`, falling back to
  the legacy `unreal443-theme` and `theme` keys), dark unless the visitor chose
  light. It also sets `color-scheme` and the `theme-color` meta
  (`#0a0a0a` / `#ffffff`). Tailwind's `light:` variant targets `.light *`.
  `globals.css` maps tokens on `:root, .dark` (dark) and `.light` (inversion).
- **Light mode is an inversion of the greys, never a new brand.** Amber stays
  `#ff8c00` in both themes.
- **Amber is the only colour.** There is no second accent and no semantic
  green/yellow; `destructive` is the single non-amber hue.
- **Structure uses the hairline, controls use a stronger border.** Rules and
  chips take `border`. A control's own edge (buttons, selects, date input,
  search) is `muted-foreground/60`, because a hairline sits near 1.4:1 against
  the canvas and a control boundary needs to clear 3:1 to be findable.
- **Poster-less events** get a seeded mesh-gradient tile
  (`apps/web/src/utils/mesh-gradient.ts`): the top field is always amber, the
  others take a hue seeded from the event's own identity, stable across renders and builds.
- **OG share cards** (`apps/web/scripts/og-card.mjs`) are a separate surface,
  rendered at build time: `#0a0a0a` ground, white title, `#8b8b8b` mark,
  `#d9d9d9` date, venue in `#e8b44a`.

## Typography

Fonts are loaded from Google Fonts in `apps/web/index.html` (a CSS `@import`
cannot sit after Tailwind's base layer): Schibsted Grotesk 700 and 800, Karla
400, 600 and 700, JetBrains Mono 400 and 700, `display=swap`. Three WOFF files
in `apps/web/assets/fonts` (Schibsted Grotesk 800, Karla 400 and 600) are
vendored only for the OG card renderer; nothing there ships to the browser.

| Role | Family | Token |
| --- | --- | --- |
| Display and titles | Schibsted Grotesk | `--font-display`, `--p443-font-display` |
| Body | Karla (`system-ui` fallback) | `--font-sans`, `--p443-font-body` |
| Labels, counts, chips | JetBrains Mono (`IBM Plex Mono`, `Menlo` fallbacks) | `--font-mono`, `--p443-font-mono` |

Body is 17px / 1.6, antialiased. Utilities in `globals.css`:

| Utility | Spec |
| --- | --- |
| `p443-display` | display, `clamp(40px, 5vw, 64px)`, 800, line-height 1, tracking -0.02em |
| `p443-headline` | display, 40px, 700, 1.1, -0.01em |
| `p443-section-title` | display, 28px, 700, 1.15 |
| `p443-card-title` | display, 20px, 700, 1.3 |
| `p443-dek` | body, 20px, 400, 1.5 |
| `p443-eyebrow` | body, 13px, 700, uppercase, 0.08em, muted ink |
| `p443-eyebrow-accent` | same, amber |
| `p443-btn` | body, 16px, 600, 4px radius |
| `p443-wordmark` | display, 20px, 800, -0.01em |

Components also use the `micro` utility (`index.css`) and its twin `MICRO` in
`layout.ts`: mono, 11px, weight 500, line-height 1.4, 0.14em tracking,
uppercase. It is the one label shape on the page; colour is left to the caller
(muted by default, amber when it marks something).

## Radii

`--p443-r-none` 0, `--p443-r-sm` 2px, `--p443-r-md` 4px; shadcn `--radius` is
4px. Controls and cards use 4px; skeleton text bars use 2px.

## Layout and spacing

From `layout.ts`:

- `SHELL = "mx-auto w-full max-w-5xl px-5 sm:px-8"`: one measure (64rem) and one
  gutter (20px, 32px from the `sm` breakpoint) for the whole page.
- `GUTTER = "-mx-5 px-5 sm:-mx-8 sm:px-8"`: the matching negative margin so the
  sticky day headers paint edge to edge inside the shell. Change `SHELL` and
  `GUTTER` together.
- Shared shapes, spelled once so controls cannot drift: `BUTTON`, `FIELD`
  (select, date input, search), `LABEL` (a `micro` caption above a field) and
  `MICRO`.

Spacing scale tokens (`--p443-space-*`): xs 8, sm 12, md 16, lg 24, xl 32,
xxl 48 (px). Most components use Tailwind's own scale on the same 4px grid.

## Touch targets

- Buttons, fields, icon buttons: `h-11` / `size-11` (44px) on phones, dropping to
  `sm:h-10` (40px) from the `sm` breakpoint where a pointer is expected.
- Text-only links and chips that are smaller than that get `min-h-11` with
  offsetting vertical padding and negative margin, so the hit area reaches 44px
  without moving the layout.
- Fields are `text-base` (16px) on phones so iOS never zooms the page on focus,
  `sm:text-[15px]` after.

## Focus

`focus-ring` (`index.css`) is the only focus style: on `:focus-visible`, a solid
2px outline in `--ring` (amber), 2px offset. It is written out in full because
Tailwind's `outline-none` + `focus-visible:outline-2` pair leaves the outline
style at `none`. Controls in `apps/web` carry it.

Exception, deliberate: after a client-side navigation the app moves focus to the
new page's `<h1>` or `<main>` (`tabindex="-1"`, see `focusPage` in `app.tsx`) so
screen readers announce the page; those landmarks draw no ring.

## Motion policy

Motion is incidental and always opt-out-able:

- **Transitions are `motion-safe:`.** Colour, border, width and the small icon
  transforms use `motion-safe:transition-*` (150 to 200ms), so they are absent
  under `prefers-reduced-motion: reduce`. Loading skeletons use
  `motion-safe:animate-pulse`.
- **The map** (`components/map`) disables its fill/stroke transition in CSS under
  `prefers-reduced-motion: reduce` and turns off Leaflet's `fadeAnimation` from
  `matchMedia`. Wheel-zoom is off so the map never hijacks page scroll.
- **Navigation** restores scroll on back/forward and resets to the top on a new
  page (`app.tsx`, `utils/scroll-state.ts`).

Known gaps (not yet guarded by the reduced-motion policy): `html` sets
`scroll-behavior: smooth` in `globals.css` with no reduced-motion override; the
map's loading placeholder in `map-view.tsx` uses an unguarded `animate-pulse`;
the shadcn dropdown/menu primitives in `packages/ui` carry their own
`animate-in/out` classes.

## Do and don't

- Do take colours from the semantic tokens so both themes work; never hard-code a
  grey in a component.
- Do keep amber rare: it should mark the one thing to act on or the active state.
- Do use `focus-ring`, `BUTTON`, `FIELD` and `MICRO` rather than re-deriving them.
- Don't add a second accent colour or a radius above 4px.
- Don't change the type scale or tokens here without changing
  `globals.css` / `index.css` in the same commit.
