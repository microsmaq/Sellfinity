# Deploying Sellfinity to sellfinity.app

Target setup: Vercel (app) + Neon Postgres (database) + the sellfinity.app
domain. ~1 hour of clicking, plus eBay's production-keyset review time.

## 1. Database — Neon Postgres — DONE (July 2026)

The schema runs on Neon (`neondb`), the initial migration is committed in
`prisma/migrations/`, tests use the `sellfinity_test` database, and local dev
uses the isolated `sellfinity_dev` schema via `.env`. Vercel needs both
`DATABASE_URL` (the **pooled**
`-pooler` URL) and `DIRECT_DATABASE_URL` (the direct URL, used by
`prisma migrate deploy`).

## 2. App — Vercel (~15 min)

1. Push the repo to GitHub.
2. https://vercel.com → Add New Project → import the repo.
3. Build command: `npm run vercel-build` (runs prisma generate + migrate
   deploy + next build).
4. Environment variables (Production):
   - `DATABASE_URL` — Neon **pooled** URL; `DIRECT_DATABASE_URL` — direct URL
   - `EBAY_ENV` — `SANDBOX` at first; flip to `PRODUCTION` when the
     production keyset is live
   - `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` — matching keyset
   - `EBAY_RU_NAME` — the RuName for that keyset (see step 4)
   - `EBAY_VERIFICATION_TOKEN` — any 32+ char secret (also entered in the
     eBay portal in step 4)
5. Deploy. Note: Vercel's Hobby tier disallows commercial use — use Pro.

## 3. Domain (~10 min + DNS propagation)

1. Vercel project → Settings → Domains → add `sellfinity.app` (and
   `www.sellfinity.app` redirecting to the apex).
2. At your registrar, set the DNS records Vercel shows (A/ALIAS + CNAME).
   `.app` is an HSTS-preloaded TLD — HTTPS only, which Vercel provides
   automatically.

## 4. eBay production access (start early — has review lag)

1. Developer portal → apply for the **production keyset** ("Application
   Growth Check" for API limits comes later; the keyset itself needs the
   account-deletion compliance step below).
2. **Account deletion notifications** (portal → Alerts & Notifications →
   Marketplace Account Deletion):
   - endpoint: `https://sellfinity.app/api/ebay/account-deletion`
   - verification token: the exact value of `EBAY_VERIFICATION_TOKEN`
   - eBay sends a challenge to the endpoint on save; the app answers it
     automatically (deploy first, then configure this).
3. Create a **production RuName** (User Tokens → Get a Token via Your
   Application):
   - auth accepted URL: `https://sellfinity.app/api/ebay/callback`
   - privacy policy URL: `https://sellfinity.app/privacy`
4. Set the production keyset + RuName in Vercel env vars, flip
   `EBAY_ENV=PRODUCTION`, redeploy. Sellers connect via Settings → the OAuth
   redirect works normally on a real domain (the paste-URL fallback remains
   as a backup).

## 5. Before announcing the site

- Delete (or change the password of) the seeded **demo@sellfinity.dev**
  account in the production database — it's public knowledge and holds the
  connected eBay sandbox account.

## 6. Post-launch hardening (from README "Known limitations")

- Encrypt stored eBay tokens at rest.
- Login rate limiting + password reset flow.
- Real data feeds for mirroring/arbitrage/sourcing (Rainforest or similar)
  behind the existing interfaces.

## What's already handled in code

- `EBAY_ENV` switches all eBay hosts (auth, API, item links).
- `vercel-build` script runs migrations on every deploy.
- Session cookies are `secure` in production.
- `/privacy` and `/api/ebay/account-deletion` exist and are tested.
