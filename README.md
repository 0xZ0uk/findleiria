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
`local-auth.db`, the dev ports); read it for the optional ones (the D1 and R2
build values, `SITE_URL`, the deploy hook, `DIGEST_KEYWORDS`). Variables
exported in the shell override both files. Production uses two separate
environments, the Workers Builds build variables and the Worker's own
variables and secrets; see Deploy.

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
- The schema's types are generated too: varlock regenerates `env.d.ts` (and
  `apps/web/src/env.d.ts` for `import.meta.env`) on every load. Both are
  committed so `tsc` works on a fresh clone. `wrangler types` already declares
  `NodeJS.ProcessEnv` (for the Worker's secrets), so varlock does not; the env
  modules in `packages/env` and `packages/auth` read schema-typed values
  instead.
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
`packages/auth`). If the production build reads it, add it to the Workers
Builds build variables; if the Worker reads it, add it as a Worker var or
secret (and to `secrets.required` in `wrangler.jsonc` if it cannot be missing).
Browser code only ever sees `VITE_`-prefixed items, and those must be
`@public`.

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
(mirror `local.db` into D1, then the Workers Builds deploy hook that rebuilds
the site from it), then prints a summary.

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
whenever new ones land, from the repo root (the auth database has its own
`db:migrate:remote`, see Deploy):

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
`tsc --noEmit`; the production build (`pnpm cf:build`) is separate and needs D1
and R2 values, so CI does not run it. `pnpm typecheck` and `pnpm test` also
cover the Worker (`worker/`, outside turbo's workspaces).

The same lint, typecheck and test steps run on every pull request and on pushes
to `master` (`.github/workflows/ci.yml`; no secrets needed), plus a
`wrangler deploy --dry-run` and a check that `worker-configuration.d.ts` is
current (`pnpm cf:types` regenerates it).

### 9. Deploy (Cloudflare Workers)

Production is **one Cloudflare Worker** (`wrangler.jsonc`) serving a **static
SPA built from a snapshot of D1** plus the same-origin API. The browser never
talks to a database: the build reads the events from D1 once and writes
everything the site serves into `apps/web/dist/`, which Workers Static Assets
hosts. The Worker (`worker/index.ts`) only answers `/api/*` (sign-in, saved
events, analytics beacon) and `/data/*` (so a missing file is a real 404, not
the SPA shell); every other path is answered by the assets layer. Same origin
is deliberate: the session cookie must be first-party (Safari drops
third-party ones, and most readers are on an iPhone).

The build writes:

- `data/agenda.json`: the agenda (dated rows a little wider than the 90-day
  window, which the page trims against the reader's clock; the undated
  announcements; the last-run stats)
- `data/events/<slug>.json`: one file per event, past ones included, for the
  event page and the saved list
- `evento/<slug>/index.html` (head tags, JSON-LD and the event embedded for a
  request-free first paint), `og/<slug>.png`, `sitemap.xml`, `robots.txt`

The daily flow (`pnpm --filter server daily`, see Cron automation) is scrape →
`db:publish` (mirrors `local.db` into the `findleiria-events` D1 database) →
deploy hook → Workers Builds runs the build, which reads that D1 database →
deploy. There is no Hono process in production; the local scraper is the only
writer of events. Static Assets allow 20,000 files per version on Free and
100,000 on Paid, and the build emits about three files per event (json, html,
png), so Workers **Paid** is what this plan assumes (Free's 10 ms CPU limit
also breaks password hashing).

#### One-time Cloudflare resources

From a machine with `pnpm exec wrangler login`:

```bash
pnpm exec wrangler d1 create findleiria-events
pnpm exec wrangler d1 create findleiria-auth      # put its id in wrangler.jsonc (database_id)
pnpm exec wrangler r2 bucket create findleiria-build-cache
```

- **D1 ids.** Commit the `findleiria-auth` id into `wrangler.jsonc`
  (`d1_databases[0].database_id`, now a zero placeholder). The events database
  needs no Worker binding; `packages/db/wrangler.jsonc` finds it by name and
  everything else uses `EVENTS_D1_ID`.
- **R2.** Create an R2 API token scoped to that one bucket (Object Read &
  Write) and add a lifecycle rule deleting objects older than 60 days (bumping
  `OG_CACHE_VERSION` leaves the old `og-cards/v<N>/` prefix behind).
- **API tokens** (My Profile → API Tokens): one with D1 **read** only for the
  build (`D1_READ_API_TOKEN`), one with D1 **edit** for `db:publish`
  (`D1_RW_API_TOKEN`, cron machine only). They are separate on purpose: the
  build must not be able to write.
- **Email.** Onboard the sending domain under Compute → Email Service → Email
  Sending (it needs Cloudflare DNS; `workers.dev` cannot send):
  `pnpm exec wrangler email sending enable <domain>`.
- **Web Analytics.** Add the site, copy its token (`VITE_CF_BEACON_TOKEN`).
  The Analytics Engine dataset `findleiria_events` is created by the first
  write; custom events go to `POST /api/track` (an allow-list of event names,
  currently `fonte`).
- **Google OAuth.** Add `<origin>/api/auth/callback/google` as an authorized
  redirect URI.

#### Databases and migrations

Both D1 databases are migrated from the same committed drizzle migrations the
local files use. Apply new ones before the deploy that needs them (a Worker
never migrates):

```bash
pnpm --filter @events-tracker/auth db:migrate:remote   # findleiria-auth: users, sessions, saved events, rate_limit
pnpm db:migrate:remote                                  # findleiria-events (= pnpm --filter @events-tracker/db db:migrate:remote)
```

The auth tables, including the `rate_limit` table behind sign-in throttling,
must exist or sign-in fails. `db:publish` refuses to run while the events
database lacks a table, column or index. Copying the existing users, sessions
and events over from Turso, and the cutover itself, are not covered here: they
are the migration runbook (CF-10 of the Cloudflare migration plan).

#### Workers Builds

Connect the repo under Workers & Pages → Create → Import a repository (or the
Worker's Settings → Build). The Worker name must equal `name` in
`wrangler.jsonc` (`findleiria`).

| Setting | Value |
| --- | --- |
| Production branch | `master` |
| Root directory | `/` |
| Build command | `pnpm cf:build` (web build + prerender + `varlock scan`; no auth package build, the Worker bundles `packages/auth` from source) |
| Deploy command | `pnpm cf:deploy` (`wrangler deploy`) |
| Non-production branch deploy command | `pnpm cf:preview` (`wrangler versions upload`) |

Workers Builds installs dependencies itself and sets `WORKERS_CI=1`. Its
default image has Node 24 and pnpm 10.11 (the `packageManager` field in
`package.json` pins the exact pnpm); set `NODE_VERSION=22` as a build variable
to match CI. Pushes to `master` deploy; any other branch uploads a version with
its own preview URL. Preview versions share the production bindings (D1,
secrets), and their origin is not `BETTER_AUTH_URL`, so use them to look at the
static site, not to sign in.

Two separate environments, and a value in one is invisible to the other (this
is why the old build-time `env:check:production` is gone):

| Where | Variable | Kind |
| --- | --- | --- |
| **Build** variables and secrets (Settings → Build) | `CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID` | plain |
| | `D1_READ_API_TOKEN` | secret, D1 read-only |
| | `SITE_URL` | plain: the public origin, e.g. `https://findleiria.pt`. Required: canonical URLs, sitemap, robots.txt and the host printed on OG cards |
| | `VITE_CF_BEACON_TOKEN` | plain (public by design) |
| | `R2_ACCOUNT_ID`, `R2_BUILD_CACHE_BUCKET` | plain |
| | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret, bucket-scoped key |
| | `NODE_VERSION=22` | optional |
| **Worker** runtime (Settings → Variables & Secrets, or `wrangler secret put`) | `BETTER_AUTH_SECRET` (32+ chars: `openssl rand -base64 48`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secrets |
| | `BETTER_AUTH_URL` (the public origin, exactly what the browser types), `MAIL_FROM` (`FindLeiria <no-reply@<domain>>`) | vars |
| | `AUTH_TRUSTED_ORIGINS` | optional var, comma-separated |

Do not put a `file:` `SNAPSHOT_DATABASE_URL` in the build variables: on
Workers Builds (`WORKERS_CI`) the build refuses it and always reads D1.

**Required secrets.** `wrangler.jsonc` declares `secrets.required`
(`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), so
`wrangler deploy` and `versions upload` fail, naming the missing ones, rather
than ship a Worker that cannot sign anyone in. A Worker that does not exist yet
cannot have secrets set in advance, so do the very first deploy by hand:
`pnpm cf:build && pnpm exec wrangler deploy --secrets-file <file of NAME=value
lines>`, then connect Workers Builds. The plain vars have no such guard: until
`BETTER_AUTH_URL`, `MAIL_FROM` and the secrets are all set and well-formed, the
Worker answers `/api/auth/*` and `/api/saved` with a generic 500
(`server_misconfigured`) and logs the missing **names** once per isolate
(`worker/auth-guard.ts`); the static site keeps working. The domain is not
decided yet, which is why `BETTER_AUTH_URL` and `MAIL_FROM` are not in
`wrangler.jsonc` `vars`; once it is, add them there (a comment in the file
has the lines).

**What fails the build** (and the previous deployment keeps serving): missing
`SITE_URL`; missing D1 variables; a `file:` snapshot source on Workers Builds;
a database with no events; a snapshot file that is missing or empty; or any JS
chunk containing the D1 database id, the read token, the Cloudflare API path or
a libSQL client. After the prerender, `varlock scan ./dist` fails the build if
any `@sensitive` value present in the build env appears anywhere in the
published output. D1 reads in the build retry 429 and 5xx up to three times
with backoff (honouring `Retry-After`); the publish writes never retry.

#### OG card cache (R2)

Rendered cards are cached between builds in the `findleiria-build-cache`
bucket under `og-cards/v<N>/<key>.png` (`apps/web/scripts/og-r2.mjs`, S3 API
with the `R2_*` build variables). The key hashes the card text, the template
(renderer + fonts) and the site host, so changing `SITE_URL` re-renders every
card. Before rendering the build downloads the keys it needs, after rendering
it uploads the new ones and deletes the unused ones. With the `R2_*` variables
unset the build is simply cold (renders everything), never failed.

#### Redeploy after publish

Otherwise events scraped since the last deploy have no page, card or sitemap
entry. In the Worker's Settings → Build → **Deploy Hooks**, create a hook for
the production branch and set its URL as `DEPLOY_HOOK_URL` in the root
`.env.local` on the machine that runs the cron, next to `CLOUDFLARE_ACCOUNT_ID`,
`EVENTS_D1_ID` and the D1-edit `D1_RW_API_TOKEN` (see the `#db` items in
`.env.schema`). `db:publish` POSTs to it only after the D1 swap has committed,
logs the host and the `build_uuid` Workers Builds answers with, and exits
non-zero if the hook fails ("published but not redeployed"). The URL is the
credential (no header is needed): treat it as a secret, and delete and recreate
the hook if it leaks. A hook fired while the previous build is still queued does
not start another; it answers with that build. Limits: 10 builds a minute per
Worker.

#### CI

`.github/workflows/ci.yml` runs lint, typecheck, tests, the Worker's typecheck
and tests, a check that `worker-configuration.d.ts` matches `wrangler.jsonc`
(`pnpm cf:types`, re-run it after editing the config), and
`wrangler deploy --dry-run` so binding and config drift fails the pull request.
It never builds the site (that needs D1 and R2 secrets) or deploys.

## Stack

pnpm + Bun monorepo · React SPA with pathname routing, no router library (web,
:3300) · better-auth (Google + email/password) on a separate auth database ·
Drizzle (libSQL files `local.db` / `local-auth.db` in dev, Cloudflare D1 in
production) · one Cloudflare Worker serves the static SPA and `/api`
(Workers Static Assets + Hono, built by Workers Builds) · Hono also runs as a
**local-dev only** server (auth, saved events, digest) · Turborepo + Biome.

```
apps/server/     scraper (src/scraper/) + digest CLI; Hono API for dev only
apps/web/        static SPA: / (agenda + map), /evento/<slug>, /guardados, /entrar
packages/api/    query functions (src/queries/), snapshot builder
packages/auth/   better-auth config, auth DB schema + migrations, Hono routes
packages/db/     Drizzle schema, migrations, seeds (src/client.ts = env-free read client)
packages/ui/     shared tokens (styles/globals.css) and primitives; see DESIGN.md
worker/          the Cloudflare Worker entry: /api/auth, /api/saved, /api/track, /data/*
wrangler.jsonc   Worker config: assets, D1/email/analytics bindings, Workers Builds settings
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
pnpm cf:build               # the production build (what Workers Builds runs)
pnpm cf:deploy              # wrangler deploy (Workers Builds runs it; first deploy by hand)
pnpm cf:preview             # wrangler versions upload (non-production branches)
pnpm cf:types               # regenerate worker-configuration.d.ts after editing wrangler.jsonc
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
   D1 (see Deploy). The dev-only Hono server mounts the auth routes,
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

