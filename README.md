# VeoClara

The reveal homepage is live at https://veoclara.com/ following PR #2.
Cloudflare Pages must build with `node scripts/build-pages.mjs` and publish
`dist`, rather than the repository root. This uses the same `.assetsignore`
allowlist as the static Worker, includes routing and security headers, and
adds a real 404 page. Backend source, configuration and development files
are excluded from both static publishing paths.
The API Worker also returns 404 for repository source paths (`worker/`,
`scripts/`, `README.md` and `wrangler.jsonc`) before Pages caching. These routes
prevent old assets from being served after removal from a static deployment.

The proposed homepage in `index.html` is the post-reveal VeoClara awareness
campaign. `prelaunch.html` preserves the earlier waitlist teaser and is excluded
from search indexing. `campaign.js` connects its pledge form
to the separate pledge service in the existing Cloudflare API Worker.

The proposed public reveal route is `/`. `_redirects` sends older reveal links
to the homepage.
The existing internal D1 resource name is retained to keep its database binding
and stored data intact; it is not the public site name.

The reveal hero reuses the live site's golden rotation film and neutral product
frame. `product-media.js` provides pause/play, pauses media off-screen or in a
hidden tab, and respects reduced-motion/data-saving preferences. A lightweight
existing VeoClara JPEG remains as the fallback when the film cannot load.

## Pledge behavior

- `POST /api/submit` validates name (1–50 characters), one of 36 states/UTs,
  optional city (up to 50 characters), explicit pledge consent, request UUID,
  timing/honeypot fields and a verified Turnstile token.
- A random request UUID makes retries idempotent. A keyed fingerprint of network,
  normalized name and state also detects practical duplicates. These are saved
  pledges, **not verified unique citizens**; shared networks/names can overlap.
- `GET /api/stats` returns only real aggregate totals. Names, cities, request IDs
  and fingerprints are never returned publicly. New tables begin empty; no demo
  participation is seeded or imported from legacy tables.
- Database constraints and triggers maintain totals atomically. Aggregate reads
  return at most 36 rows and are cached for 60 seconds per Cloudflare location.
  A save refreshes that location's cache, so immediate reloads show the new total.
- A database-backed fixed-window limiter allows 12 attempts per network per ten
  minutes. Rate fingerprints older than 24 hours are eligible for bounded cleanup
  on subsequent valid requests. Saved deduplication fingerprints remain with the
  pledge. No raw IP is stored in the pledge database or application pledge logs.
- Success appears only after server confirmation. Network retries do not double
  count, API failures stay visible, and storage-disabled browsers can still submit.

## Local development

Use Node 22.13 or later. From `worker/`:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace PLEDGE_IP_SECRET in .dev.vars with a generated random local value.
npm run d1:migrate:local
npm run typecheck
npm test
```

The example contains Cloudflare's documented public **test** Turnstile keys.
They must never be used in production; the pledge endpoint rejects them outside
localhost. `.dev.vars`, node_modules and local database files are git-ignored.
Tests run the real migration/SQL against an isolated in-memory SQLite database,
with a D1 adapter and mocked external CAPTCHA verification.

Serve a directory containing the public root HTML/JS/images with Wrangler assets:

```sh
npx wrangler dev --config wrangler.toml --local --host localhost --port 8787 --assets /absolute/path/to/public-assets
```

Use `--host localhost`: without it Wrangler rewrites requests to the configured
production route hostname, and the production guard correctly rejects test keys.
Do not include `worker/`, `files/`, `.git/`, environment files or node_modules in
the public asset directory. For an empty local email-waitlist database only, run
`npx wrangler d1 execute neosightai-db --config wrangler.toml --local --file=schema.sql` as well.

## Production activation, in order

The root `wrangler.jsonc` describes the static `veoclara` Worker used by the
connected build job. `.assetsignore` allows only public HTML, frontend scripts
and the referenced brand media. The `worker/wrangler.toml` configuration is the
separate `veoclara-api` service; do not deploy one configuration as the other.

Production is **not** activated by this branch alone. Static Pages deployment and
the API Worker are separate. The existing email waitlist's `TURNSTILE_*` settings
are intentionally unchanged.

1. Renew Cloudflare access (`npx wrangler login`, then `npx wrangler whoami`).
2. Create a production Turnstile widget allowing `veoclara.com` and
   `www.veoclara.com`. The form uses the action `pledge`.
3. Set these new Worker secrets from `worker/`, without putting values in Git:

   ```sh
   npx wrangler secret put --config wrangler.toml PLEDGE_TURNSTILE_SITE_KEY
   npx wrangler secret put --config wrangler.toml PLEDGE_TURNSTILE_SECRET
   openssl rand -hex 32 | npx wrangler secret put --config wrangler.toml PLEDGE_IP_SECRET
   ```

   Keep the IP secret stable: rotating it changes duplicate fingerprints.
4. Review/apply the additive production migration:
   `npm run d1:migrate`. It creates only `pledges`, `pledge_totals`,
   `pledge_rate_limits`, their indexes and triggers. It leaves `waitlist` and any
   legacy `submissions` table intact. It creates no sample records.
5. Run `npm test`, `npm run typecheck` and
   `npx wrangler deploy --config wrangler.toml --dry-run`, then deploy the API with `npm run deploy`.
6. Deploy the reviewed static changes, including `campaign.js` and `product-media.js`, through the site's
   existing release process. Confirm the homepage, the legacy redirects, privacy and terms.
7. Verify live empty/real totals, a controlled pledge and database read-back,
   same-request retry, a failure state and a mobile browser. Remove any controlled
   test record by its ID; the delete trigger automatically adjusts totals. Allow
   up to 60 seconds for cached aggregates to refresh.
8. Confirm `privacy@veoclara.com` receives requests and an owner can process them.
   Merge/release the homepage only after approval of the reveal switch.

No public administration/deletion API is exposed. An authorized operator uses D1
to find/remove the requested pledge and follows up using the privacy process.
After campaign close, remove retained pledge records and their fingerprints.

## Rollback

Revert the static release and redeploy the previous API version if needed. The
new tables can remain in place; do not drop them or clear the email waitlist as a
rollback step. Restoring older UI must not substitute demo totals for real ones.

## Deployment state — 29 October 2026

Cloudflare access has been renewed. The production pledge migration, managed
Turnstile widget and three `PLEDGE_*` secrets are configured. API version
`2e773e04-f325-4b9e-a0a3-e9fb57f20395` serves the pledge endpoints. A controlled
live browser check passed CAPTCHA validation, saving, refresh and same-request
retry. Its synthetic pledge was removed after the check; no demo totals were
imported. Keep the configured IP secret stable rather than regenerating it.

The static Worker configuration also uploads successfully and excludes internal
files. The public homepage switch remains awaiting approval and PR release.
The proposed homepage is available in the branch/local previews; the production
waitlist homepage has not yet been replaced.
