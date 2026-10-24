# events-tracker

Personal events tracker for Leiria, Portugal. Scrapes local event sources into
one deduplicated calendar with a web UI and a daily Discord digest.

**Status:** 16 scraper sources (registry: `apps/server/src/scraper/index.ts`),
feeding one deduplicated calendar that is published as a static snapshot.

## Setup guide

### 1. Prerequisites

- **Node 22.3+** (varlock's minimum) and **pnpm 10+** (`corepack enable`
  works — the repo pins `pnpm@10.34.4`)
- **Bun 1.4+** (`curl -fsSL https://bun.sh/install | bash` — the server,
  scrapers and CLI all run on Bun)

### 2. Install & env

```bash
git clone git@github.com:0xZ0uk/unreal-events.git
cd unreal-events
pnpm install
```

Env is managed by [varlock](https://varlock.dev). The committed
[`.env.schema`](.env.schema) at the repo root is the single source of truth:
every variable the code reads, with its description, type, default and
whether it is required or `@sensitive`. Values live next to it in a
gitignored **`.env.local`** (or `.env`; `.env.local` wins), one file for the
whole monorepo. Local dev needs three:

```bash
# .env.local (repo root)
BETTER_AUTH_SECRET=      # 32+ chars: openssl rand -base64 48
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

```bash
pnpm env:check           # = varlock load: validates, prints values (secrets masked)
```

Everything else has a working default in the schema (`local.db`,
`local-auth.db`, the dev ports); read it for the optional ones (Turso, the
deploy hook, SMTP, Umami, `DIGEST_KEYWORDS`). Variables exported in the shell
override both files.

How it is wired:

- Each package's `package.json` has
  `"varlock": { "loadPath": "../../", "filter": "#<tag>" }`, and its scripts
  run through `varlock run`, which validates the items tagged for that package
  and injects only those (`#server`, `#db`, `#auth`, `#web`).
  `pnpm --filter <pkg> exec varlock load` shows exactly what a package gets.
- Vite loads the same schema through `@varlock/vite-integration`.
- `bun test` runs with no env at all: Bun's own `.env` loading is off
  (`bunfig.toml`), and the test preloads point every database at a throwaway
  one, so tests never reach a real database.
- `process.env` is typed from the schema: varlock regenerates `env.d.ts` (and
  `apps/web/src/env.d.ts` for `import.meta.env`) on every load. Both are
  committed so `tsc` works on a fresh clone.
- Moving from the old per-app files: merge `apps/server/.env`,
  `apps/web/.env` and `packages/db/.env` into the root `.env.local`, then
  delete them (they are no longer read). `TURSO_AUTH_TOKEN` is the
  **read-only** token; the publish token is `TURSO_RW_TOKEN`.
- Secrets can be kept encrypted at rest: set a value to `varlock(prompt)` in
  `.env.local` and run `pnpm env:check` (see varlock's local encryption docs).
- The varlock CLI sends anonymous usage telemetry; opt out once with
  `pnpm exec varlock telemetry disable`.

**Adding an env var:** declare it in `.env.schema` (a description comment,
`@type`, `@required`/`@sensitive` as needed, and a `@tag(...)` for every
package that reads it: `varlock run` strips untagged schema items from a
package's process), run `pnpm env:check` to regenerate the types, then read it
from `process.env` (or add it to `env` / `authEnv` in `packages/env` /
`packages/auth`). If the Vercel build or functions read it, add it to the
Vercel project env too. Browser code only ever sees `VITE_`-prefixed items,
and those must be `@public`.

Optional: if your machine's dev ports collide (3000/3001 are commonly taken),
set `PORT` and the matching `CORS_ORIGIN` in `.env.local`, and change the
`port` and proxy target in `apps/web/vite.config.ts` accordingly.

### 3. Database

SQLite at the repo root — migrations are committed, so after install:

```bash
cd packages/db && bun run db:migrate:deploy && bun run db:seed && cd ../..
```

That creates `local.db` with the 4 tables (`venues`, `events`,
`event_sources`, `scrape_runs`) plus 10 seed venues. Schema changes later:
`bun run db:generate` (new migration) + `bun run db:push`.

### 4. Run

```bash
pnpm dev        # web :3300 + server :3301 (turbo)
```

Open http://localhost:3300 — first visit shows an empty agenda until the
first scrape.

The web app reads no database, in dev or in production: it fetches a static
JSON snapshot from `/data/` (see `packages/api/src/snapshot-shape.ts`). In dev,
`pnpm dev` writes that snapshot from `local.db` into `apps/web/public/data/`
(gitignored) before Vite starts. It is a copy, so after a scrape regenerate it
and reload the page:

```bash
pnpm --filter web snapshot          # local.db → apps/web/public/data/
SNAPSHOT_DATABASE_URL=file:/abs/path/other.db pnpm --filter web snapshot
```

If `local.db` does not exist yet, `pnpm dev` still starts and the agenda says
it has not been published; run the snapshot once the database exists.

### 5. First scrape

```bash
pnpm --filter server scrape            # every source, sequentially
# or one at a time:
pnpm --filter server scrape:leiriagenda
```

Each source prints `{found, new, updated, failed, error}` and writes a
`scrape_runs` row. Run it twice — the second must report `new: 0`
(idempotency invariant). Note: **Eventbrite rate-limits hard**; if a run
dies with HTTP 429 wait a few minutes before retrying — the run is recorded
and the next scheduled run self-heals.

Optional, one-time: geocode the venues for map work later:

```bash
pnpm --filter server geocode:venues   # Nominatim, 1 req/s, idempotent
```

### 6. Digest & calendar

```bash
pnpm --filter server digest                # plaintext digest of upcoming events
DIGEST_KEYWORDS=tattoo,jazz pnpm --filter server digest -- --new 24
```

- `--new N` limits to events ingested in the last N hours
- `DIGEST_KEYWORDS` ⭐-marks watchlist hits in the output
- Paste-a-link ingest:
  `pnpm --filter server ingest:url -- https://leiriagenda.cm-leiria.pt/pt/agenda/<slug>`

### 7. Cron automation (Hermes-specific)

The daily scrape + Discord digest are Hermes Agent cron jobs (see
`/.plans/SLICE_EVENTS_TRACKER.md`): scrape all sources daily at 07:00, digest
to Discord at 09:00. To replicate elsewhere, cron these two commands:

```bash
cd apps/server && bun run scrape    # every source
DIGEST_KEYWORDS="..." bun run digest --new 24   # pipe to your notifier
cd ../../packages/db && bun run db:publish      # mirror into Turso + redeploy
```

Go through the package scripts (they wrap `varlock run`): a bare
`bun src/...` gets no env, since Bun's own `.env` loading is off.

### 8. Tests & checks

```bash
pnpm lint          # biome ci . (lint + format + import order; read-only)
pnpm check         # biome check --write . (apply the safe fixes)
pnpm typecheck     # tsc in every package (turbo check-types; same as pnpm check-types)
pnpm test          # bun test in every package that has tests (turbo test)
```

The tests are offline (fixtures, no network) and need no `.env`: 619 across
server (442), web (63), api (92) and auth (22); `db` and `env` have none. To run
one package: `pnpm --filter server test`. `apps/web`'s `check-types` is plain
`tsc --noEmit`; the production build (`vite build`) is separate and needs a
database, so CI does not run it.

The same lint, typecheck and test steps run on every pull request and on pushes
to `master` (`.github/workflows/ci.yml`; no secrets needed).

### 9. Deploy (Vercel + Turso, no server)

Production is a **static SPA built from a daily snapshot of Turso**. The browser
never talks to the database: the Vercel build reads Turso once and writes
everything the site serves into `apps/web/dist/`:

- `data/agenda.json`: the agenda (dated rows a little wider than the 90-day
  window, which the page trims against the reader's clock; the undated
  announcements; the last-run stats)
- `data/events/<slug>.json`: one file per event, past ones included, for the
  event page and the saved list
- `evento/<slug>/index.html` (head tags, JSON-LD and the event embedded for a
  request-free first paint), `og/<slug>.png`, `sitemap.xml`

The daily flow is scrape → `db:publish` (mirrors `local.db` into Turso) →
deploy hook → Vercel rebuild. There is no Hono process in production; the local
scraper is the only writer.

```bash
turso db create unreal-events
export DATABASE_URL="$(turso db show unreal-events --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create unreal-events)"
(cd packages/db && bun run db:migrate)           # then import/dump existing rows
turso db tokens create unreal-events --read-only # token for the Vercel build
```

Vercel: import the repo with **Root Directory = repo root** — `vercel.json` owns
install/build/output, so no framework preset is needed. Project env
(Settings → Environment Variables; mark the secrets **Sensitive**). These are
the schema's `#web` and `#auth` items:

| Variable | Action | Value |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | **add** (if absent) | the `libsql://…` URL |
| `TURSO_AUTH_TOKEN` | **add** (if absent) | the **read-only** token; build-time only |
| `AUTH_DATABASE_URL` | **add** | `libsql://…` of the separate auth database |
| `AUTH_TURSO_TOKEN` | **add** | its read/write token |
| `BETTER_AUTH_SECRET` | **add** | 32+ chars (`openssl rand -base64 48`) |
| `BETTER_AUTH_URL` | **add** | the public origin, e.g. `https://findleiria.vercel.app` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | **add** | the OAuth client |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | **add** | required: the functions run with `NODE_ENV=production` |
| `SMTP_PORT`, `SMTP_SECURE`, `AUTH_TRUSTED_ORIGINS` | optional | defaults `587` / `false` / none |
| `VITE_UMAMI_SRC`, `VITE_UMAMI_WEBSITE_ID` | optional | public analytics ids |
| `NODE_ENV` | **do not set** | Vercel sets it; the build check forces `production` |
| `VITE_TURSO_URL` | **delete** | no longer read; would only invite re-inlining |
| `VITE_TURSO_AUTH_TOKEN` | **delete** | was inlined into the public bundle |

The build command first runs `pnpm --filter ./packages/auth env:check:production`
(`NODE_ENV=production varlock load` over the `#auth` items), so a missing or
malformed auth variable fails the deploy rather than the first sign-in. The
functions read `process.env` as Vercel injects it: a deployment's env cannot
change without a rebuild, so they run on values the build already checked.
After the prerender, `varlock scan ./dist` fails the build if any `@sensitive`
value present in the build env (tokens, auth secrets, the Turso URL) appears
anywhere in the published output.

The build fails, and Vercel keeps serving the previous deployment, if
`TURSO_DATABASE_URL` is missing, the database has no events, a snapshot file is
missing or empty, or any JS chunk contains the database host or a libSQL client.
Since the old read-only token shipped in every bundle, consider rotating it:
`turso db tokens invalidate unreal-events` revokes every token for the
database, so then issue a new read-only one for Vercel and a new read/write one
for `db:publish`.

Redeploy after publish (otherwise events scraped since the last deploy have no
page, card or sitemap entry): in Vercel, **Settings → Git → Deploy Hooks**,
create a hook for the production branch, and set it as
`VERCEL_DEPLOY_HOOK_URL` in the root `.env.local` on the machine that runs the
cron, next to `TURSO_DATABASE_URL` and the read/write `TURSO_RW_TOKEN` (see
the `#db` items in `.env.schema`). `db:publish` POSTs to it only after Turso
has committed, and exits non-zero if the hook fails.

## Stack

better-t-stack monorepo · pnpm + Bun · React + TanStack Router (web, :3300) ·
Drizzle + libSQL (`local.db` in dev, remote Turso in production) · Hono + tRPC
survive as a **local-dev only** surface · Turborepo + Biome.

```
apps/server/     scraper (src/scraper/) + digest CLI; Hono API for dev only
apps/web/        static SPA (single view: / = the agenda)
packages/api/    query functions (src/queries/) + tRPC routers wrapping them
packages/db/     Drizzle schema, migrations, seeds (src/client.ts = env-free read client)
```

## Commands

```bash
pnpm install
pnpm check-types            # typecheck everything
pnpm lint                   # biome ci .
pnpm test                   # bun test in every package with tests
pnpm --filter server scrape             # all sources
pnpm --filter server scrape:leiriagenda # single source
pnpm --filter server geocode:venues     # Nominatim geocoding (idempotent)
pnpm --filter server digest             # plaintext digest (--new N supported)
pnpm --filter server ingest:url -- <url> [venue]   # paste-a-link ingest
pnpm dev                    # turbo dev (web :3300, server :3301)
```

Sources registry: `apps/server/src/scraper/index.ts` —
the 16 ids are the keys of `sources` (leiriagenda, cmleiriarss, bol,
eventbrite, viralagenda, ticketline, ...).

## How it works

1. **Scrape** — each source returns `{events, failures, firstError}`. Per-card
   failures are counted, never fatal; fetches carry a 15s timeout + 2 retries;
   request caps enforced exactly; every run writes a `scrape_runs` row.
2. **Fingerprint** — dated: `sha1(normalizedTitle|venueSlug|YYYY-MM-DD HH:mm
   Europe/Lisbon)`; undated: `...|UNDATED` (never rotates). Same-day twin
   sessions stay distinct.
3. **Ingest** — venue resolve-or-create, event upsert by fingerprint,
   `event_sources` attribution rows, ghost cleanup when an undated event
   gains a date.
4. **Serve** — the SPA reads no database: it fetches the static JSON snapshot
   (`/data/agenda.json`, `/data/events/<slug>.json`) that the build writes from
   Turso (see Deploy). The dev-only Hono server exposes the query functions
   (`events.list`, `byDay`, `undated`, `venues`, `stats`) over tRPC plus
   `/digest` (JSON).
5. **Cron (Hermes)** — daily scrape 07:00 (all sources; 0-found×2 days =
   broken-selector alert), daily Discord digest 09:00 (`DIGEST_KEYWORDS`
   watchlist → ⭐ lines, rest compressed).

## Data model

- `venues` — name, slug, address, lat/lng (16 geocoded), city
- `events` — title, slug, description, start_at/end_at (epoch), venue_id,
  image_url, url, categories (JSON), fingerprint (unique), date_text
  (non-null ⇒ undated: start_at is an ingestion placeholder, calendar views
  exclude it)
- `event_sources` — attribution per (event, source)
- `scrape_runs` — source, started/finished, items_found/new/failed, error

## Deferred

- Visite Leiria (JS-rendered dates) + Ticketline (bot-walled) — need the
  Playwright pipeline; parked.

Plan: `/root/.plans/SLICE_EVENTS_TRACKER.md`

