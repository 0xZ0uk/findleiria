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
git clone git@github.com:0xZ0uk/findleiria.git
cd findleiria
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
  delete them (they are no longer read). The web build reads the events
  from D1 with the **read-only** token `D1_READ_API_TOKEN`; publishing uses the
  D1-edit token `D1_RW_API_TOKEN`.
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

Sign-in lives in a **second** database (`local-auth.db`, `AUTH_DATABASE_URL`)
with its own committed migrations (user, session, account, verification, saved
events and the auth rate-limit counters). Create it once, and again whenever a
pull adds an auth migration:

```bash
pnpm --filter @events-tracker/auth db:migrate
```

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

Each source prints `{status, found, discovered, new, updated, failed, error}`
and writes a `scrape_runs` row; the cleanup passes run once at the end. Run it twice — the second must report `new: 0`
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

The daily job and the Discord digest are Hermes Agent cron jobs: the daily
job at 07:00, the digest at 09:00. To replicate elsewhere, cron these two
commands from the repo root:

```bash
pnpm --filter server daily                               # 07:00
DIGEST_KEYWORDS="..." pnpm --filter server digest -- --new 24   # 09:00, pipe to your notifier
```

`daily` (`apps/server/src/scraper/daily.ts`) runs every source in turn, then
the cleanup passes (purge, venue merge, reconcile) once, then `db:publish`
(mirror `local.db` into D1 + Vercel deploy hook), then prints a summary.

- One failed source never stops the others.
- Publish is **skipped** when the batch failed hard: a cleanup pass threw, or
  more than half of the sources failed. One or a few failed sources still
  publish the rest.
- Exit code is 0 only when every source, every pass and the publish (with
  its redeploy) succeeded, so cron flags any failure, including the ones that
  were published around.
- An `ALERT <source>` line means that source's listing came back empty, which
  points to a broken parser or a block rather than a quiet day. Alerts are
  printed but do not fail the job on their own.

Every source's `scrape_runs` row records found / discovered (listing size) /
pages fetched / new / updated / pruned / failed, plus `error`, `warnings`
(e.g. the prune circuit breaker refusing) and `postpass_error`.

`pnpm --filter server scrape [source]` is the same batch without the publish
(it exits 1 when a source or a pass failed).

Go through the package scripts (they wrap `varlock run`): a bare
`bun src/...` gets no env, since Bun's own `.env` loading is off.

**D1 migrations.** The publish mirrors every local column into the
`findleiria-events` D1 database, and the site's build reads all of them, so D1
has to be migrated as far as `local.db`. Apply the same committed drizzle
migrations (`packages/db/src/migrations`, wired by `packages/db/wrangler.jsonc`)
whenever new ones land, from the repo root:

```bash
pnpm --filter @events-tracker/db db:migrate:remote   # wrangler d1 migrations apply findleiria-events --remote
```

It uses your `wrangler login`, or `CLOUDFLARE_API_TOKEN=<D1_RW_API_TOKEN>`
(with `CLOUDFLARE_ACCOUNT_ID` from `.env.local`). `db:publish` refuses to run
(and prints this command) while D1 lacks a table, column or index.

**How the publish stays atomic.** D1's REST API has no `BEGIN`/`COMMIT`, so
`db:publish` (`packages/db/src/publish-d1.ts`) loads the rows into
`<table>_next` staging tables over as many requests as needed, then swaps them
in with **one** request (check the staged counts, drop the live tables, rename
the staging ones, rebuild the indexes). D1 runs a multi-statement request as
one transaction, so the site's build sees the whole old copy or the whole new
one. A failure before the swap leaves the live tables untouched; leftover
`_next` tables are dropped by the next run. It also refuses local rows whose
foreign key points at nothing, since D1 enforces foreign keys.

### 8. Tests & checks

```bash
pnpm lint          # biome ci . (lint + format + import order; read-only)
pnpm check         # biome check --write . (apply the safe fixes)
pnpm typecheck     # tsc in every package (turbo check-types; same as pnpm check-types)
pnpm test          # bun test in every package that has tests (turbo test)
```

The tests are offline (fixtures, no network) and need no `.env`: about 640
across server (~430), web (~80), api (~107) and auth (~25); `db` and `env` have
none. The api query tests run real SQL against a throwaway libSQL file with the
committed migrations (`packages/api/src/test-db.ts`). To run
one package: `pnpm --filter server test`. `apps/web`'s `check-types` is plain
`tsc --noEmit`; the production build (`vite build`) is separate and needs a
database, so CI does not run it.

The same lint, typecheck and test steps run on every pull request and on pushes
to `master` (`.github/workflows/ci.yml`; no secrets needed).

### 9. Deploy (Vercel + Turso, no server)

Production is a **static SPA built from a daily snapshot of Turso**. The browser
never talks to the database: the Vercel build reads Turso once and writes
everything the site serves into `apps/web/dist/`. The build reads the events
from the `findleiria-events` D1 database over the D1 REST API with a read-only
token (`CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID`, `D1_READ_API_TOKEN`; a
`file:` `SNAPSHOT_DATABASE_URL` reads a local SQLite file instead):

- `data/agenda.json`: the agenda (dated rows a little wider than the 90-day
  window, which the page trims against the reader's clock; the undated
  announcements; the last-run stats)
- `data/events/<slug>.json`: one file per event, past ones included, for the
  event page and the saved list
- `evento/<slug>/index.html` (head tags, JSON-LD and the event embedded for a
  request-free first paint), `og/<slug>.png`, `sitemap.xml`

The daily flow (`pnpm --filter server daily`, see Cron automation) is scrape →
`db:publish` (mirrors `local.db` into D1; the build below reads that D1
database) → deploy hook → Vercel rebuild. There is no Hono process in production; the local
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
| `CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID` | **add** | the account and the `findleiria-events` D1 id |
| `D1_READ_API_TOKEN` | **add** | Cloudflare API token with D1 **read** only; build-time only |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | **delete** | the build no longer reads Turso |
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

**Auth database migration (one-time per auth migration, before the deploy that
needs it).** The functions never migrate: the auth tables, including the
`rate_limit` table that backs sign-in throttling, must already exist in the
production auth database, or sign-in fails. Run this from a checkout, with the
production URL and read/write token in the shell (they override `.env.local`):

```bash
AUTH_DATABASE_URL='libsql://<auth-db>.turso.io' AUTH_TURSO_TOKEN='<read-write token>' \
  pnpm --filter @events-tracker/auth db:migrate
```

OG cards are cached between builds in `apps/web/node_modules/.cache/og-cards`
(keyed by card content, pruned each build); Vercel restores `node_modules/**`
with its build cache, and a cold cache just renders every card.

The build command first runs `pnpm --filter ./packages/auth env:check:production`
(`NODE_ENV=production varlock load` over the `#auth` items), so a missing or
malformed auth variable fails the deploy rather than the first sign-in. The
functions read `process.env` as Vercel injects it: a deployment's env cannot
change without a rebuild, so they run on values the build already checked.
After the prerender, `varlock scan ./dist` fails the build if any `@sensitive`
value present in the build env (tokens, auth secrets) appears
anywhere in the published output.

The build fails, and Vercel keeps serving the previous deployment, if
the D1 variables are missing, the database has no events, a snapshot file is
missing or empty, or any JS chunk contains the D1 database id, the read token,
the Cloudflare API path or a libSQL client.
Since the old read-only token shipped in every bundle, consider rotating it:
`turso db tokens invalidate unreal-events` revokes every token for the
database, so then issue a new read-only one for Vercel and a new read/write one
for `db:publish`.

Redeploy after publish (otherwise events scraped since the last deploy have no
page, card or sitemap entry): in Vercel, **Settings → Git → Deploy Hooks**,
create a hook for the production branch, and set it as
`VERCEL_DEPLOY_HOOK_URL` in the root `.env.local` on the machine that runs the
cron, next to `CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID` and the D1-edit
`D1_RW_API_TOKEN` (see the `#db` items in `.env.schema`). `db:publish` POSTs
to it only after the D1 swap has committed, and exits non-zero if the hook
fails.

## Stack

pnpm + Bun monorepo · React SPA with pathname routing, no router library (web,
:3300) · better-auth (Google + email/password) on a separate libSQL database ·
Drizzle + libSQL (`local.db` in dev, remote Turso in production) · Hono
survives as a **local-dev only** surface (auth, saved events, digest) ·
Turborepo + Biome.

```
apps/server/     scraper (src/scraper/) + digest CLI; Hono API for dev only
apps/web/        static SPA: / (agenda + map), /evento/<slug>, /guardados, /entrar
packages/api/    query functions (src/queries/), snapshot builder
packages/auth/   better-auth config, auth DB schema + migrations, Hono routes
packages/db/     Drizzle schema, migrations, seeds (src/client.ts = env-free read client)
packages/ui/     shared tokens (styles/globals.css) and primitives; see DESIGN.md
api/             Vercel functions for /api/auth and saved events
```

## Commands

```bash
pnpm install
pnpm check-types            # typecheck everything
pnpm lint                   # biome ci .
pnpm test                   # bun test in every package with tests
pnpm --filter server daily              # cron job: all sources + passes + publish
pnpm --filter server scrape             # all sources (no publish)
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
   Turso (see Deploy). The dev-only Hono server mounts the auth routes,
   `/api/saved` and `/digest` (JSON); there is no query API.
5. **Cron (Hermes)** — `daily` at 07:00 (all sources, cleanup passes once,
   publish; an empty listing prints an `ALERT` line), daily Discord digest 09:00 (`DIGEST_KEYWORDS`
   watchlist → ⭐ lines, rest compressed).

## Data model

- `venues` — name, slug, address, lat/lng (nullable), city, scope
  (`venue` | `lugar` | `concelho`; only `venue` is drawn as a map pin)
- `events` — title, slug, description, start_at/end_at (epoch), venue_id,
  image_url, url, categories (JSON), fingerprint (unique), date_text
  (non-null ⇒ undated: start_at is an ingestion placeholder, calendar views
  exclude it)
- `event_sources` — attribution per (event, source)
- `scrape_runs` — source, started/finished, items_found/discovered/new/
  updated/pruned/failed, pages_fetched, error, warnings, postpass_error

## Deferred

- Visite Leiria (JS-rendered dates) — needs the Playwright pipeline; parked.
  (Ticketline is no longer deferred: its search pages are server-rendered and
  the `ticketline` scraper is registered.)

Slice plans live in `.plans/`.

