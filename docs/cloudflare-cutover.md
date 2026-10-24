# Cloudflare cutover runbook

Moves production from Vercel + Turso (+ SMTP, Umami) to the Cloudflare Worker
described in README section 9. Follow the phases in order. Every step ends with
a **Verify** line; do not continue until it passes. Every phase ends with a
**Rollback** note.

Conventions:

- `<DOMAIN>` is the new public hostname (for example `findleiria.pt`), and
  `https://<DOMAIN>` is the new origin. It is `BETTER_AUTH_URL` and `SITE_URL`.
- "Operator machine" is where you run `wrangler login`. "Cron machine" is the
  Hermes machine that runs `pnpm --filter server daily`.
- Commands run from the repository root unless a `cd` says otherwise. The
  checkout must contain the Cloudflare code (branch `cf/migration` or `master`
  after it is merged), and `pnpm install` must have run.
- Secrets never go in the repo, in shell history or in a ticket. Export them
  into the current shell from your password manager, and close the shell when
  you are done.
- Keep a scratch directory **outside the repository** for files that hold user
  data (`mkdir -m 700 ~/cutover-tmp`). It is emptied in phase 7.

What changes for readers: the origin changes, so cookies do not carry over and
everybody signs in again once. Accounts, passwords, Google links and saved
events are copied over, so nothing else is lost.

What changes for the daily job: from phase 1 on, `db:publish` writes to D1 and
no longer to Turso, so the **old Vercel site stops receiving new events**. Do
phases 1 to 5 in one sitting, or at least on the same day.

---

## Phase 0: prerequisites

Nothing here touches production.

1. **Workers Paid** is active on the account (Free's 10 ms CPU limit breaks
   password hashing, and its 20,000-file cap is too small).
2. The domain is on **Cloudflare DNS** (zone active). Email Sending cannot send
   from `workers.dev`.
3. Log in and create the resources:

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler d1 create findleiria-events
   pnpm exec wrangler d1 create findleiria-auth
   pnpm exec wrangler r2 bucket create findleiria-build-cache
   ```

   Write down both `database_id` values.
4. **R2**: create an API token scoped to the `findleiria-build-cache` bucket
   (Object Read & Write), and add a lifecycle rule that deletes objects older
   than 60 days (R2 -> findleiria-build-cache -> Settings -> Object lifecycle
   rules).
5. **API tokens** (My Profile -> API Tokens): one with D1 **read** only (the
   build, `D1_READ_API_TOKEN`) and one with D1 **edit** (`D1_RW_API_TOKEN`, cron
   machine only; it is also what `db:migrate:remote` for the events database
   uses).
6. **Email Sending**: onboard the domain, then check it.

   ```bash
   pnpm exec wrangler email sending enable <DOMAIN>
   ```

7. **Web Analytics**: add the site and copy its beacon token
   (`VITE_CF_BEACON_TOKEN`). The Analytics Engine dataset `findleiria_events` is
   created by the first write.
8. **Google OAuth**: in Google Cloud Console -> APIs & Services -> Credentials,
   add `https://<DOMAIN>/api/auth/callback/google` to the existing client's
   authorized redirect URIs. Keep the old Vercel URI until phase 7.
9. **Commit the two database ids.** Put the auth id into `wrangler.jsonc`
   (`d1_databases[0].database_id`, replacing the zero placeholder). The events
   database needs no id in the repo (`packages/db/wrangler.jsonc` looks it up by
   name; everything else uses `EVENTS_D1_ID`). Open a PR and merge it, or commit
   on the branch you will deploy from.
10. **D1 atomicity smoke test** (`db:publish` relies on it). On a scratch
    database, a multi-statement request that fails must roll back as a whole:

    ```bash
    pnpm exec wrangler d1 create scratch-atomicity          # note its id as SCRATCH_ID
    export CLOUDFLARE_ACCOUNT_ID=<account id> SCRATCH_ID=<scratch id>
    export D1_RW_API_TOKEN=<the D1 edit token>               # from the password manager
    curl -sS -X POST \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$SCRATCH_ID/query" \
      -H "Authorization: Bearer $D1_RW_API_TOKEN" -H "Content-Type: application/json" \
      --data '{"sql":"CREATE TABLE t(x); SELECT * FROM missing"}'
    pnpm exec wrangler d1 execute scratch-atomicity --remote \
      --command "SELECT name FROM sqlite_master WHERE name = 't'"
    ```

    **Verify:** the `curl` answers `"success": false` and the second command
    returns **zero rows** (the `CREATE TABLE` was rolled back). If table `t`
    exists, stop: the publish would not be atomic, and this migration cannot go
    ahead until `db:publish` is changed. Then clean up:
    `pnpm exec wrangler d1 delete scratch-atomicity`.
11. **Vercel side, before anything merges to master.** The Vercel project is
    still connected to the Git repository. Once the Cloudflare code lands on
    `master`, Vercel would try to build it and fail (its `api/` and
    `vercel.json` are gone); the live deployment would keep serving, but it
    would be noisy. In Vercel -> the project -> Settings -> Git, **disconnect**
    the repository. Do not delete any deployment (Instant Rollback in the
    Rollback section needs them). Write down the Vercel project's environment
    variables you will reuse: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
    `GOOGLE_CLIENT_SECRET`. If Vercel will not show a value, a new
    `BETTER_AUTH_SECRET` (`openssl rand -base64 48`) is fine, because no cookie
    survives the origin change anyway.

**Rollback:** delete what you created (`wrangler d1 delete`, `wrangler r2
bucket delete`, revoke tokens). Production is untouched.

---

## Phase 1: events database

1. Create the schema in the events database (from the repo root, using your
   `wrangler login`, or `CLOUDFLARE_API_TOKEN=<D1_RW_API_TOKEN>` plus
   `CLOUDFLARE_ACCOUNT_ID`):

   ```bash
   pnpm db:migrate:remote
   ```

   **Verify:**

   ```bash
   pnpm exec wrangler d1 execute findleiria-events --remote \
     --config packages/db/wrangler.jsonc \
     --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
   ```

   lists the tables of `packages/db/src/schema` (events, sources, scrape_runs and
   the rest) plus `d1_migrations`.
2. **Cron machine**: pull the Cloudflare code (`git pull`, `pnpm install`), then
   edit the root `.env.local`:

   ```bash
   cp .env.local ~/cutover-tmp/env.local.pre-cloudflare    # keep for rollback
   ```

   - **Remove** `TURSO_DATABASE_URL`, `TURSO_RW_TOKEN`, `TURSO_AUTH_TOKEN` and
     every `VERCEL_*` line (including `VERCEL_DEPLOY_HOOK_URL`).
   - **Add** `CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID` (the `findleiria-events`
     id), `D1_RW_API_TOKEN`. Leave `DEPLOY_HOOK_URL` out for now: the hook does
     not exist until phase 3, and without it `db:publish` simply does not ask
     for a rebuild.

   **Verify:** `pnpm --filter @events-tracker/db exec varlock load` shows the
   three new values (secrets masked) and no `TURSO_*` or `VERCEL_*`.
3. Publish once, by hand, from the cron machine:

   ```bash
   pnpm db:publish
   ```

   **Verify:** the run prints matching local and D1 counts and exits 0. Check
   one table yourself:

   ```bash
   pnpm exec wrangler d1 execute findleiria-events --remote \
     --config packages/db/wrangler.jsonc --command "SELECT count(*) FROM events"
   sqlite3 local.db "SELECT count(*) FROM events"
   ```

   Both numbers must be equal.

**Rollback:** the events database is a mirror, so nothing here can lose data.
To go back to the old pipeline, restore `~/cutover-tmp/env.local.pre-cloudflare`
over `.env.local` and check out the pre-migration commit on the cron machine
(the Turso publish script lives in git history). The Vercel site then refreshes
again on the next daily run.

---

## Phase 2: auth database schema

```bash
pnpm --filter @events-tracker/auth db:migrate:remote
```

**Verify:**

```bash
pnpm exec wrangler d1 execute findleiria-auth --remote \
  --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
```

lists `account`, `rate_limit`, `saved_event`, `session`, `user`,
`verification` and `d1_migrations`. The data comes in phase 5; the tables are
empty now.

**Rollback:** `pnpm exec wrangler d1 delete findleiria-auth` and create it
again. Nothing reads it yet.

---

## Phase 3: first Worker deploy

The Worker declares `secrets.required`, and a Worker that does not exist yet
cannot have secrets set in advance, so the first deploy is manual. After that,
Workers Builds takes over.

1. **Put the public settings in `wrangler.jsonc`** and commit them. Add inside
   the top-level object:

   ```jsonc
   "vars": {
     "BETTER_AUTH_URL": "https://<DOMAIN>",
     "MAIL_FROM": "FindLeiria <no-reply@<DOMAIN>>"
   },
   "routes": [{ "pattern": "<DOMAIN>", "custom_domain": true }],
   ```

   They belong in the file, not in the dashboard: `wrangler deploy` deletes any
   var that is not in the config (unless `--keep-vars`), and Workers Builds
   deploys with plain `wrangler deploy`. The custom-domain route makes
   Cloudflare create the DNS record and certificate for `<DOMAIN>`.
   (`AUTH_TRUSTED_ORIGINS` is optional; leave it out.)
2. **Build locally**, with a `.env.local` on the operator machine holding the
   build values (`CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID`, `D1_READ_API_TOKEN`,
   `SITE_URL=https://<DOMAIN>`, `VITE_CF_BEACON_TOKEN`; the `R2_*` values are
   optional here, without them the build just renders every card):

   ```bash
   pnpm cf:build
   ```

   **Verify:** it finishes, `apps/web/dist/data/agenda.json` and
   `apps/web/dist/evento/` exist, and `varlock scan` reports nothing.
3. **Deploy with a temporary secrets file**, then delete it:

   ```bash
   umask 077
   cat > ~/cutover-tmp/secrets.env <<'EOF'
   BETTER_AUTH_SECRET=<value>
   GOOGLE_CLIENT_ID=<value>
   GOOGLE_CLIENT_SECRET=<value>
   EOF
   pnpm exec wrangler deploy --secrets-file ~/cutover-tmp/secrets.env
   shred -u ~/cutover-tmp/secrets.env
   ```

   Never commit this file. **Verify:** wrangler prints the `*.workers.dev` URL
   and `<DOMAIN>`, and
   `curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/` prints `200`
   (certificate provisioning can take a few minutes; retry).
4. **Connect Workers Builds**: Workers & Pages -> findleiria -> Settings ->
   Build -> Connect, pick the repository, then set:

   | Setting | Value |
   | --- | --- |
   | Production branch | `master` |
   | Root directory | `/` |
   | Build command | `pnpm cf:build` |
   | Deploy command | `pnpm cf:deploy` |
   | Non-production branch deploy command | `pnpm cf:preview` |

   Build variables and secrets (Settings -> Build -> Variables and Secrets;
   the full table is in README section 9):
   `CLOUDFLARE_ACCOUNT_ID`, `EVENTS_D1_ID`, `D1_READ_API_TOKEN` (secret),
   `SITE_URL`, `VITE_CF_BEACON_TOKEN`, `R2_ACCOUNT_ID`, `R2_BUILD_CACHE_BUCKET`,
   `R2_ACCESS_KEY_ID` (secret), `R2_SECRET_ACCESS_KEY` (secret), optionally
   `NODE_VERSION=22`.

   **Verify:** trigger a build (push a commit to `master`, or "Retry build" on
   the latest one). Build history shows success and a new version deployed.
5. **Create the Deploy Hook**: Settings -> Build -> Deploy Hooks -> add one for
   branch `master`. Copy the URL (it is a credential). On the cron machine, add
   it to `.env.local` as `DEPLOY_HOOK_URL=...`.

   **Verify:** run `pnpm db:publish` again on the cron machine. It must log the
   hook host and a `build_uuid`, and a new build appears in Workers Builds.

**Rollback:** nothing in production points at the Worker yet. To start over,
delete the Worker (Workers & Pages -> findleiria -> Settings -> Delete) and
remove the DNS record `<DOMAIN>` if one was created. Remove `DEPLOY_HOOK_URL`
from the cron machine.

---

## Phase 4: smoke test (before moving anyone)

`BETTER_AUTH_URL` is `https://<DOMAIN>`, so sign-in only works on that origin.
`workers.dev` is good for the static checks, not for auth. Replace `<DOMAIN>`
below. All of this uses throw-away accounts; they are deleted in phase 5.

**Static site**

```bash
curl -s -o /dev/null -w 'agenda  %{http_code}\n' https://<DOMAIN>/
curl -s -o /dev/null -w 'json    %{http_code}\n' https://<DOMAIN>/data/agenda.json
curl -s -o /dev/null -w 'data404 %{http_code}\n' https://<DOMAIN>/data/does-not-exist.json   # must be 404, not 200
curl -s https://<DOMAIN>/robots.txt                                                          # mentions https://<DOMAIN>/sitemap.xml
curl -s https://<DOMAIN>/sitemap.xml | head -c 600                                           # <loc> URLs on <DOMAIN>
SLUG=$(curl -s https://<DOMAIN>/sitemap.xml | grep -o '/evento/[^<]*' | head -1 | sed 's|/evento/||')
curl -s -o /dev/null -w 'event   %{http_code}\n' https://<DOMAIN>/evento/$SLUG
curl -s https://<DOMAIN>/evento/$SLUG | grep -o 'rel="canonical"[^>]*'                       # canonical on <DOMAIN>
curl -s -o /tmp/og.png -w 'og      %{http_code} %{content_type}\n' https://<DOMAIN>/og/$SLUG.png
```

Open the agenda, the event page and the OG image in a browser too (the card
shows `<DOMAIN>`). An unknown `/evento/nao-existe` must render the in-app "not
found" page.

**Cache headers**

```bash
ASSET=$(curl -s https://<DOMAIN>/ | grep -o '/assets/[^"]*\.js' | head -1)
curl -sI https://<DOMAIN>$ASSET | grep -i cache-control                  # public, max-age=31536000, immutable
curl -sI https://<DOMAIN>/data/agenda.json | grep -i cache-control       # public, max-age=0, must-revalidate
curl -sI https://<DOMAIN>/og/$SLUG.png | grep -i cache-control           # public, max-age=86400
```

**Auth** (in a browser, on `https://<DOMAIN>`)

1. Email sign-up with a **real address you control**. The Portuguese
   verification mail must arrive (check spam). Open the link, then sign in. If
   no mail arrives: `pnpm exec wrangler tail findleiria --format pretty` while
   retrying, and look for `E_*` errors from Email Sending.
2. Google sign-in (uses the redirect URI added in phase 0).
3. Save an event, reload (still saved), unsave it.
4. Throttling is recorded: after a few sign-in attempts,
   `pnpm exec wrangler d1 execute findleiria-auth --remote --command "SELECT count(*) FROM rate_limit"`
   is above 0.

**Analytics beacon** (`Origin` must equal the site; the slug only has to look
like a slug)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<DOMAIN>/api/track \
  -H 'Origin: https://<DOMAIN>' -H 'Content-Type: application/json' \
  --data '{"name":"fonte","data":{"slug":"smoke-test-0123456789ab"}}'   # 204
```

Workers Analytics Engine has no dashboard for raw rows; query the SQL API with
a token that has Account -> Account Analytics -> Read (create a temporary one,
revoke it afterwards). Data can take a minute to show up:

```bash
export CF_ANALYTICS_TOKEN=<temporary read token>
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  --data "SELECT timestamp, blob1 AS name, blob2 AS slug, blob3 AS country FROM findleiria_events ORDER BY timestamp DESC LIMIT 5"
```

The `smoke-test-0123456789ab` row must be there. Also click a "source" link on
an event page in the browser; a second row (real slug) appears.

**Verify:** every line above behaved as annotated. Web Analytics shows the
page views a few minutes later (Web Analytics -> the site).

**Rollback:** nothing to roll back; no reader knows the new origin yet. Fix and
re-run the failing check.

---

## Phase 5: cutover window

Traffic is low, so a freeze is optional. If you want one, announce a short
maintenance window; there is no read-only switch on the old site, so the
practical freeze is "do not announce the new URL until the end of this phase".
Sign-ups on the old site that land after the export are caught by step 6.

1. **Clear the smoke-test data from D1**, otherwise the import fails on the
   unique email constraint (your own address exists in both databases). The
   cascade removes sessions, accounts and saved events:

   ```bash
   pnpm exec wrangler d1 execute findleiria-auth --remote \
     --command "DELETE FROM verification; DELETE FROM rate_limit; DELETE FROM user;"
   ```

   **Verify:** `SELECT count(*) FROM user` on `findleiria-auth` returns 0.
2. **Turn the production Turso auth database into a local SQLite file**
   (Turso CLI; this only reads production):

   ```bash
   cd ~/cutover-tmp
   turso db shell findleiria-auth .dump > auth-dump.sql
   sqlite3 auth-export.db < auth-dump.sql
   sqlite3 auth-export.db "SELECT count(*) FROM user; SELECT count(*) FROM saved_event;"
   turso db shell findleiria-auth "SELECT count(*) FROM user; SELECT count(*) FROM saved_event;"
   ```

   `.dump` is the documented Turso way to export a database to SQL (it leaves
   out libSQL and SQLite internal tables); `sqlite3` rebuilds a local file from
   it. **Verify:** the local and Turso counts are equal. These files hold
   password hashes and OAuth tokens: keep them in `~/cutover-tmp` only.
3. **Convert it to a data-only D1 import.** Use absolute paths (pnpm runs the
   script from `packages/auth`):

   ```bash
   pnpm --filter @events-tracker/auth db:export-d1 -- \
     --from file:$HOME/cutover-tmp/auth-export.db --out $HOME/cutover-tmp/auth-d1.sql
   ```

   It prints the rows per table (parents first) and writes
   `auth-d1.sql.counts.json` next to the SQL. It starts the file with
   `PRAGMA defer_foreign_keys = true;`, writes no `BEGIN`/`COMMIT`, and keeps
   every statement below D1's 100 KB limit by batching rows into multi-row
   `INSERT`s of at most about 90 KB.
   **If it refuses** (the copy has a table or column the repo lacks, or lacks
   one the repo has), it says which and prints the migration files to apply to
   the **local copy** (`sqlite3 ~/cutover-tmp/auth-export.db < <file>`). Do
   that, and re-run. Never run migrations against the Turso database for this.
4. **Import into D1:**

   ```bash
   pnpm exec wrangler d1 execute findleiria-auth --remote --file $HOME/cutover-tmp/auth-d1.sql
   ```

   If wrangler rejects the `PRAGMA defer_foreign_keys` line, delete that one
   line and run again: the file is already ordered parents-first, so foreign
   keys hold without it. If the import stops half-way, repeat step 1 (it clears
   the partial data), then this step.
5. **Verify the copy**:

   ```bash
   pnpm --filter @events-tracker/auth db:verify-d1 -- \
     --counts $HOME/cutover-tmp/auth-d1.sql.counts.json
   ```

   It runs one read-only `SELECT count(*)` per table through
   `wrangler d1 execute findleiria-auth --remote --json` (your own
   `wrangler login`; no token is read or printed) and compares with the export.
   It must end with `All tables match.` and exit 0. If you prefer to run
   wrangler yourself, save its `--json` output to a file and pass
   `--result <file>` instead.
6. **Check nothing changed on the old site since the export** (new sign-ups or
   saves):

   ```bash
   turso db shell findleiria-auth "SELECT count(*) FROM user; SELECT count(*) FROM saved_event;"
   ```

   Same numbers as step 2? Continue. Different? Go back to step 1 and repeat
   the export and import; D1 has no real users yet, so this is safe until you
   announce the new origin.
7. **Sign-in check with a migrated account**: on `https://<DOMAIN>`, sign in
   with an existing email account (or Google) and confirm the saved events
   from the old site are listed. The person will need to sign in once; that is
   expected.
8. **Point the old URL at the new site.** Vercel cannot send
   `findleiria.vercel.app` anywhere without a Vercel project behind it, so the
   options are: (a) let the old URL die when the project is deleted, or (b)
   **recommended**: keep a minimal Vercel project that only redirects, for a
   few weeks (say 8) so shared links and search results keep working.

   For (b), in an empty directory outside the repo:

   ```bash
   mkdir -p ~/cutover-tmp/vercel-redirect/public && cd ~/cutover-tmp/vercel-redirect
   touch public/.keep
   cat > vercel.json <<'EOF'
   {
     "framework": null,
     "installCommand": "",
     "buildCommand": "",
     "outputDirectory": "public",
     "redirects": [
       { "source": "/(.*)", "destination": "https://<DOMAIN>/$1", "permanent": true }
     ]
   }
   EOF
   vercel link            # choose the existing findleiria project
   vercel deploy --prod
   ```

   (Check these field names against Vercel's current `vercel.json` docs; the
   goal is a production deployment with no build step that answers every path
   with a 308 to the same path on `<DOMAIN>`. If the project has framework or
   build overrides in Settings -> Build & Development, clear them. The Git
   repository stays disconnected from phase 0.)

   **Verify:** `curl -sI https://findleiria.vercel.app/evento/$SLUG` returns
   `308` with `location: https://<DOMAIN>/evento/$SLUG`. From this moment the
   old site no longer accepts sign-ups, so Turso stops changing.
9. Update the places that link to the old URL (social profiles, Google Search Console: add `<DOMAIN>` as a property and
   submit `https://<DOMAIN>/sitemap.xml`).

**Rollback:** until step 8, nothing public changed: leave things as they are
and the old site keeps working (apart from being stale, see the note at the
top). After step 8, see the Rollback section.

---

## Phase 6: soak (1 to 2 weeks)

Leave Vercel (as the redirect) and both Turso databases in place. Check daily
for the first three days, then every few days:

- **Daily job**: the cron run exits 0, `db:publish` logged matching counts and a
  `build_uuid`. A non-zero exit with "published but not redeployed" means the
  deploy hook failed (recreate it).
- **Builds**: Workers & Pages -> findleiria -> Deployments / Builds: each day's
  build succeeds. A failing build keeps the previous deployment serving, so a
  silent failure shows up only here as a stale site.
- **Worker logs**: Observability tab, or
  `pnpm exec wrangler tail findleiria --format pretty`. Look for
  `server_misconfigured`, unhandled exceptions, and **`E_*` errors from Email
  Sending** (the mailer logs the error code, never the address, for example
  `E_DELIVERY_FAILED` or `E_RECIPIENT_NOT_ALLOWED`). Verification mail failing
  means no new sign-ups.
- **D1**: Storage & Databases -> D1 -> findleiria-auth and findleiria-events
  -> Metrics: rows read and **rows written** stay far under the Paid included
  amounts (the publish writes roughly 18k rows a day); no spike in errors.
- **Users**: `pnpm exec wrangler d1 execute findleiria-auth --remote --command "SELECT count(*) FROM user"` grows, and new sign-ups verify.
- **Analytics**: Web Analytics shows traffic on `<DOMAIN>`; the Analytics
  Engine query from phase 4 returns real `fonte` rows.
- **Redirect**: `curl -sI https://findleiria.vercel.app/` still answers 308.

**Rollback:** see the Rollback section; it is cheaper the sooner you decide.

---

## Phase 7: decommission

Only after the soak and after the redirect period you chose. After this there
is no way back.

1. **Vercel**: delete the project (Settings -> General -> Delete Project). The
   old URL stops answering. Remove the Vercel deploy hook if one is left
   anywhere. Delete `~/cutover-tmp/vercel-redirect`.
2. **Turso**: destroy both databases (check the names with `turso db list`):

   ```bash
   turso db list
   turso db destroy findleiria-auth
   turso db destroy <the events database name>
   ```

   Revoke any Turso tokens that remain (`turso auth tokens` lists API tokens;
   database tokens go with the databases).
3. **Cron machine**: confirm `.env.local` has no `TURSO_*` or `VERCEL_*`
   left, then delete `~/cutover-tmp/env.local.pre-cloudflare` (it still holds
   the old tokens).
4. **User data on disk**: `shred -u ~/cutover-tmp/auth-dump.sql
   ~/cutover-tmp/auth-export.db ~/cutover-tmp/auth-d1.sql`, then remove the
   directory.
5. **Credentials**: revoke the temporary Analytics Engine read token and the
   SMTP credentials the old site used. Retire the Umami site (or the whole
   self-hosted instance if nothing else uses it). In Google Cloud Console,
   remove the old `findleiria.vercel.app` redirect URI from the OAuth client.
6. **Do not rotate `BETTER_AUTH_SECRET`.** It signs the session cookies, so
   rotating it signs every reader out again. Rotate it only if it leaked.

---

## Rollback

Until phase 7, Vercel and both Turso databases still exist, so you can go back.

**The cost, stated plainly:** everything written to the Cloudflare auth
database after the cutover is **lost on rollback**: accounts created, saves and
unsaves, and email verifications done on `<DOMAIN>`. Turso still holds the
state at the export. If you must keep those, export from D1 first (the reverse
of phase 5, by hand) and merge by hand.

To go back after phase 5:

1. **Site**: Vercel -> the project -> Deployments -> find the last deployment
   from before the redirect -> "Instant Rollback" / Promote to Production
   (this is why no deployment was deleted). That restores the old site, with
   its Turso connection. If the project's Git integration was disconnected in
   phase 0 and you want it back, reconnect it and point Production Branch at
   the pre-migration commit.
2. **Events pipeline**: on the cron machine restore
   `~/cutover-tmp/env.local.pre-cloudflare` over `.env.local` and check out the
   pre-migration commit (the Turso `publish-turso.ts` and the Vercel hook). The
   next daily run publishes to Turso again; run `pnpm --filter @events-tracker/db db:publish` once to catch up. Events scraped meanwhile are in
   `local.db`, so nothing is lost there.
3. **Google OAuth**: the old redirect URI must still be authorized (it is, until
   phase 7).
4. Leave the Cloudflare Worker running or delete it; readers who hold the new
   URL keep using it until you remove the route, and their data goes stale
   against Turso. Prefer to point `<DOMAIN>` at a redirect or take the Worker
   down.
