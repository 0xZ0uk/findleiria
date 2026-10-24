# Fonts

Vendored only for the OG share cards that `scripts/og-card.mjs` rasterises at
build time. The site itself loads its webfonts from `public/fonts` — nothing
here ships to the browser.

| File | Family | Source |
| --- | --- | --- |
| `fraunces-latin-500-normal.woff` | Fraunces 500 | Google Fonts, via Fontsource |
| `inter-latin-400-normal.woff` | Inter 400 | Google Fonts, via Fontsource |
| `inter-latin-600-normal.woff` | Inter 600 | Google Fonts, via Fontsource |

Both families are licensed under the SIL Open Font License 1.1, which permits
redistribution and embedding: <https://openfontlicense.org>.

Satori cannot read WOFF2, which is why these are WOFF. They are latin-subset,
so a card only ever renders what the sources actually publish.
