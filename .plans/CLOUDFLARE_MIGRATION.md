# Cloudflare migration: Vercel + Turso + SMTP + Umami → Cloudflare

Status: **implemented on branch cf/migration; cutover pending (docs/cloudflare-cutover.md)**.

## What production uses today, and what replaces it

| Today | Where in the repo | Cloudflare replacement |
| --- | --- | --- |
| Vercel static hosting + `vercel.json` rewrites/headers | `vercel.json`, `apps/web/dist` | **Workers Static Assets** (one Worker, `wrangler.jsonc`, `_headers`) |
| Vercel Node functions `api/auth.ts`, `api/saved.ts` (Hono) | `api/` | Same Hono app as the **Worker's `fetch` handler** (`run_worker_first: ["/api/*"]`) |
| Turso **auth** DB (users, sessions, saved events, rate-limit rows) | `packages/auth` (`@libsql/client/web`) | **D1** `findleiria-auth`, via `drizzle-orm/d1` + binding |
| Turso **events** DB (publish mirror read by the build only) | `packages/db/src/publish-turso.ts`, `apps/web/scripts/snapshot-lib.mjs` | **D1** `findleiria-events`, written by publish over the D1 REST API, read by the build over the D1 REST API |
| SMTP via nodemailer (verification mail) | `packages/auth/src/mailer.ts` | **Cloudflare Email Sending** (`send_email` binding) |
| Vercel Git integration + deploy hook (`VERCEL_DEPLOY_HOOK_URL`) | `packages/db/src/publish-turso.ts` | **Workers Builds** + **Workers Builds Deploy Hook** |
| Vercel build cache (OG cards in `node_modules/.cache/og-cards`) | `apps/web/scripts/og-cache.mjs` | **R2** bucket `findleiria-build-cache` |
| Vercel preview deployments | `AUTH_TRUSTED_ORIGINS` | Workers Builds **preview URLs** (non-production branches) |
| Self-hosted Umami + one custom event (`track("fonte")`) | `apps/web/src/components/analytics.tsx` | **Cloudflare Web Analytics** (page views) + **Workers Analytics Engine** (custom events via `/api/track`) |
| `findleiria.vercel.app` | `prerender-events.mjs` (`SITE`), `og-card.mjs`, `BETTER_AUTH_URL` | Custom domain on Cloudflare (or `*.workers.dev`, see decisions) |

Not moving (stays as is): the scraper + digest on the Hermes cron machine (Bun,
local `local.db`), the local dev setup (Bun Hono dev server + libSQL files),
`bun test` (offline, libSQL file DBs). They keep working because the
Cloudflare code paths are selected by the `workerd` export condition, the same
trick `#libsql-client` already uses for `bun` vs `default`.

Verified while planning:
- better-auth's drizzle adapter only calls `db.transaction()` for MySQL, and its
  `transaction` option defaults to `false`, so the sqlite provider works on D1
  (D1 rejects `BEGIN`).
- Static Assets limits: 20,000 files per version (Free) and 100,000 (Paid);
  25 MiB per file. The build emits about 3 files per event (json, html, png),
  and past events are kept, so Free has a ceiling of roughly 6.5k events.
- Free-plan CPU is 10 ms per request, which better-auth's password hashing
  exceeds. Paid allows 30 s by default.
- Workers Builds Deploy Hooks exist (changelog 2026-04-01). Calling one is
  `POST https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<id>`,
  which returns a `build_uuid`.

## Decisions needed before work starts

1. **Domain.** Email Sending needs a domain onboarded to Cloudflare; it
   cannot send from `workers.dev`. Recommendation: a custom domain on
   Cloudflare DNS. Without one, CF-4 becomes "keep an external mail provider
   over HTTP" (nodemailer's raw SMTP sockets are not a good fit for workerd).
   Changing the origin signs everyone out once and needs a new Google OAuth
   redirect URI. Saved events are kept because they're tied to the user, not
   the cookie.
2. **Workers Paid ($5/mo).** Recommended, and effectively required: Free's
   10 ms CPU breaks password sign-in, the daily full-table mirror can approach
   D1 Free's 100k rows written per day, and the 20k-file cap applies.
3. **Scraper stays on Hermes.** Recommended. Moving it to Cron Triggers and
   Workflows is a rewrite: it uses `bun:sqlite` and other Bun APIs, has long
   polite-delay runs, and sources like Shotgun and Eventbrite already
   challenge or rate-limit datacenter IPs. It's listed under Later, below.

## Issues

Effort scale: **XS** < 1h · **S** ≈ half a day · **M** ≈ 1 day · **L** 2–3 days · **XL** a week+.

### CF-0: Provision Cloudflare resources (you, or an agent with your `wrangler login`) · **S**
- Workers Paid; domain onto Cloudflare DNS (if decision 1 = yes).
- `wrangler d1 create findleiria-events`, `wrangler d1 create findleiria-auth`.
- `wrangler r2 bucket create findleiria-build-cache` plus an R2 S3 access key
  pair scoped to that bucket, plus a lifecycle rule deleting objects older than
  60 days (an `OG_CACHE_VERSION` bump leaves the old prefix behind).
- API tokens: **D1 read** (build), **D1 edit** (publish, cron machine only).
- `wrangler email sending enable <domain>`.
- Web Analytics site (beacon token); Analytics Engine dataset `findleiria_events`.
- Google OAuth: add `<new origin>/api/auth/callback/google`.
- Atomicity smoke test on a scratch D1 database (CF-3's publish relies on it):
  `POST …/d1/database/<id>/query` with `{"sql":"CREATE TABLE t(x); SELECT * FROM missing"}`
  must fail AND leave no table `t`.
- Commit the two `database_id`s (not secrets) into `wrangler.jsonc` and
  `packages/db/wrangler.jsonc`.
- Output: the IDs and tokens, recorded in `.env.local` / Workers Builds env.
  Nothing secret is committed.

### CF-1: Worker for static hosting + API (replaces `vercel.json` and `api/`) · **M**
- Add root `wrangler.jsonc`: `main: worker/index.ts`, `compatibility_flags:
  ["nodejs_compat"]`, a recent `compatibility_date`, `assets: { directory:
  "apps/web/dist", binding: "ASSETS", not_found_handling:
  "single-page-application", run_worker_first: ["/api/*", "/data/*"] }`, and
  D1/email/AE bindings.
- `worker/index.ts`: a Hono app mounting `authRoutes` + `savedRoutes` (the
  same sub-apps the Bun dev server mounts). `/data/*` goes to `env.ASSETS`
  and returns a **real 404** on a miss, never the SPA shell, matching the
  current `/((?!api/|data/).*)` exclusion.
- Port the headers to `apps/web/public/_headers`: `/assets/*` immutable,
  `/data/*` must-revalidate, `/og/*` 1 day.
- `/evento/<slug>` and `/evento/<slug>/` serve the prerendered
  `index.html` (`html_handling`); an unknown slug gets the SPA shell (the
  not-found page relies on this).
- Delete `api/` and `vercel.json`. Generate `worker-configuration.d.ts`
  with `wrangler types`.
- Acceptance: `wrangler dev` against a built `dist` serves the agenda, event
  pages, `/data/*` (404 on a missing file), and `/api/auth/get-session`.
  Tests are unchanged and pass.

### CF-2: Auth database → D1 · **M**
- `packages/auth`: replace the `#libsql-client` import map with an
  `#auth-db` map. `workerd` resolves to a module that builds
  `drizzle(env.AUTH_DB)` from `drizzle-orm/d1` using
  `import { env } from "cloudflare:workers"`. `bun` keeps the libSQL file
  client, so tests and the dev server are unchanged.
- Widen the `AuthDb` type to the shared async SQLite base so both drivers
  type-check.
- Keep `drizzle-kit generate` for authoring. Production applies migrations
  with `wrangler d1 migrations apply findleiria-auth --remote`
  (`migrations_dir` → `packages/auth/src/migrations`). Add a
  `db:migrate:remote` script.
- `authEnv`: `AUTH_DATABASE_URL` / `AUTH_TURSO_TOKEN` become dev-only. Under
  workerd, `process.env` is populated from vars/secrets (nodejs_compat), so
  the rest of `authEnv` keeps working.
- Remove `@libsql/client/web`. Check that `saved.ts` uses no
  `db.transaction` (none found today).
- Acceptance: `bun test` passes unchanged. Under `wrangler dev` with local
  D1 and migrations applied, sign-up, verify, sign-in, save, and unsave all
  work, and the rate-limit rows are written.

### CF-3: Events DB → D1 and `db:publish` rewrite · **L**
- `publish-turso.ts` → `publish-d1.ts` (Bun, cron machine). Talks to the D1
  REST API with the D1-edit token.
- Keep every existing guard: unclassified local tables, missing remote
  columns and indexes (query `sqlite_master` / `PRAGMA` over REST), scrape_runs
  retention, and post-publish counts.
- **Atomicity is required.** Verify whether the REST batch endpoint is
  transactional. If it isn't (or its size limits get in the way), load into
  `*_next` tables and swap with `ALTER TABLE … RENAME` in one batch. A
  half-published DB must stay impossible.
- Budget writes: prefer a diff-based upsert/delete over DELETE-all +
  INSERT-all if the full mirror costs too many row-writes. Measure it on
  the real `local.db`.
- Migrations: `wrangler d1 migrations apply findleiria-events --remote`. Update
  the error hints that currently print the Turso command.
- Replace `TURSO_DATABASE_URL`, `TURSO_RW_TOKEN`, `TURSO_AUTH_TOKEN` with
  `CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID`, `D1_RW_API_TOKEN` in
  `.env.schema` (#db).
- Acceptance: unit tests for the pure parts (planning, diffing, guards), as
  `publish-lib` has today. A dry run against a scratch D1 database mirrors
  `local.db` exactly (counts match), and a forced failure mid-publish leaves the
  previous data intact.

### CF-4: Verification mail → Cloudflare Email Sending · **S** (needs decision 1)
- `mailer.ts`: under `workerd`, send through `env.EMAIL.send(...)` (the
  `send_email` binding) with `from` on the onboarded domain. Under `bun`,
  keep printing the link to the console.
- Drop `nodemailer`, `@types/nodemailer`, and `SMTP_*`. Add `MAIL_FROM`
  (required in production).
- Keep the `Mailer` seam, since tests inject a recorder.
- Acceptance: tests pass; a real sign-up on a preview deploy receives the
  pt-PT verification email with both html and text parts.
- Shares `packages/auth/package.json` with CF-2, so run it after CF-2 or
  give both to the same agent.

### CF-5: Build reads the snapshot from D1 · **M** (after CF-3)
- `snapshot-lib.mjs` / `createReadDb`: for a remote source, a drizzle
  `sqlite-proxy` driver over the D1 REST `/query` endpoint with the
  **read-only** token. `file:` URLs keep using libSQL (dev, `snapshot`).
- Update the leak guard: the needles become the D1 database id, the API
  token value, and `api.cloudflare.com/client/v4/accounts`, plus the
  existing `libsql`. `varlock scan ./dist` stays.
- Keep the empty or missing snapshot guards as they are.
- Acceptance: `pnpm --filter web build` against the scratch D1 produces the
  same `dist/data` as against `local.db` (diff the JSON).

### CF-6: Workers Builds CI/CD + deploy hook · **S** (after CF-1, CF-5)
- Connect the repo in Workers Builds. Build: the current
  `env:check:production` → auth build → web build chain. Deploy:
  `wrangler deploy`. Non-production branches: `wrangler versions upload`
  (preview URLs).
- Build env: D1 read token, account id, events DB id, R2 cache keys,
  `VITE_CF_BEACON_TOKEN`. Runtime secrets (`wrangler secret put`):
  `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_*`; vars: `BETTER_AUTH_URL`,
  `AUTH_TRUSTED_ORIGINS`, `MAIL_FROM`.
- Publish: `VERCEL_DEPLOY_HOOK_URL` → `DEPLOY_HOOK_URL`. Parse
  `build_uuid` from the response for the log line. Keep it a credential (log
  the host only).
- `.github/workflows/ci.yml`: add `wrangler types --check` (or equivalent) and
  `wrangler deploy --dry-run` so binding and config drift fails PRs.

### CF-7: OG card cache → R2 · **S**
- `og-cache.mjs` stays pure. Add a sync step in `prerender-events.mjs`:
  before rendering, download the keys this build needs that exist in R2; after
  rendering, upload the new ones and delete unused ones. This uses the S3 API
  (`aws4fetch`, a small dependency) with the bucket-scoped key.
- A missing R2 config makes the build cold (it renders everything), not
  broken, matching today's behaviour.
- Acceptance: a second build with no event changes renders 0 cards.

### CF-8: Analytics: Umami → Web Analytics + Analytics Engine · **S**
- `analytics.tsx`: inject the Cloudflare Web Analytics beacon when
  `VITE_CF_BEACON_TOKEN` is set. It's cookieless, so there's still no banner.
- `track(name, data)` keeps its signature and calls
  `navigator.sendBeacon("/api/track", …)`. The Worker validates against an
  allow-list of event names (today only `fonte`), caps the payload, and calls
  `env.ANALYTICS.writeDataPoint`.
- Drop `VITE_UMAMI_*`.

### CF-9: Env schema, hard-coded origin, docs, cleanup · **S** (last code issue)
- `SITE_URL` replaces the hard-coded `findleiria.vercel.app` in
  `prerender-events.mjs` and `og-card.mjs`.
- `.env.schema` final pass: tags, `@sensitive`, and removing everything for
  Turso, Vercel, SMTP, and Umami. Regenerate `env.d.ts`.
- README §9 (Deploy) and the Cron section rewritten for Cloudflare. Fix the
  "Vercel" comments in `packages/auth`, `apps/web`, `daily.ts`, `not-found.tsx`.
- Leave the Shotgun "Vercel Security Checkpoint" detection alone: it describes
  a third-party site, not this deployment.

### CF-10: Data migration & cutover runbook · **M** (human-in-the-loop)
- Script plus runbook: dump the Turso auth DB, strip `libsql_*`,
  `_litestream*`, `__drizzle_migrations`, and `BEGIN`/`COMMIT`, then
  `wrangler d1 execute findleiria-auth --remote --file`. Seed
  `d1_migrations` with the already-applied migrations. Verify row counts per
  table.
- Events DB: apply migrations, then run `db:publish` once from the cron
  machine.
- Cutover: a brief freeze (sign-ups only), the final auth copy, DNS, the
  Google OAuth URI, smoke test (sign-in with Google and email, save, event
  page, OG, sitemap), and pointing Hermes' `.env.local` at the new
  publish env.
- Soak for 1–2 weeks, then delete the Vercel project and the Turso
  databases, and revoke the Turso tokens.

## Order / parallelism

```
CF-0 (you) ──┬── CF-1 Worker ───────────────┐
             ├── CF-2 Auth→D1 ── CF-4 Email ┤
             ├── CF-3 Events→D1 ── CF-5 Build reads D1 ── CF-6 Builds+hook ── CF-9 cleanup ── CF-10 cutover
             ├── CF-7 OG→R2 ────────────────┤
             └── CF-8 Analytics ────────────┘
```

Wave 1 (parallel, separate worktrees): CF-1, CF-2, CF-3, CF-7, CF-8.
Wave 2: CF-4, CF-5. Wave 3: CF-6, CF-9. Wave 4: CF-10 (with you).
Contested file: `.env.schema`. Each issue edits only its own section, and
CF-9 reconciles them.

Code work only needs CF-0 for end-to-end checks. Wave 1 can start against
local D1 (`wrangler dev`) and scratch resources.

## Later (not in this migration)

- **Scraper on Cron Triggers + Workflows + D1** (**XL**): see decision 3.
- **Per-event artifacts in R2** (**M**): serve `/data/events/*`,
  `/evento/*`, `/og/*` from R2 through the Worker, which removes the
  file-count ceiling and could let publish update the site without a rebuild.
- Turnstile on sign-up (**S**), Workers Rate Limiting binding in front of
  `/api/auth` (**S**), Cloudflare Images for the hot-linked event images (**M**),
  `@cloudflare/vite-plugin` for workerd parity in `pnpm dev` (**M**).
