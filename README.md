# SellPilot

One tool for eBay dropshippers and resellers: find winning products, list them,
keep stock in sync, and know what you actually profited.

## Modules

- **Amazon mirroring** (`/mirror`) — paste Amazon product URLs (one per line
  for bulk, up to 50) and each becomes an imported product plus an eBay-ready
  draft: SEO-optimized 80-char title, bullet-point description, images, and a
  charm price with a guaranteed margin over the Amazon buy price. Optionally
  publishes immediately. Mirrored products participate in inventory sync and
  profit tracking like any other.
- **Product sourcing** (`/sourcing`) — a daily-refreshing feed of candidates
  ranked 0–100 by margin (40%), demand (35%), and competition (25%), with
  per-unit profit estimates net of eBay fees and shipping. Import to inventory
  in bulk.
- **Auto-listing** (`/listings`) — generates eBay-ready titles (80-char limit,
  word-boundary truncation), descriptions, charm pricing with a guaranteed
  break-even floor, and an oversell-buffer quantity. Bulk draft → publish →
  end, with inline price/qty edits that revise the live listing.
- **Inventory sync** (`/inventory`) — checks every active listing against live
  supplier stock/cost. Flags out-of-stock, stock drift (oversell risk and
  restock), loss-making prices after cost rises, and delisted supplier
  products. Paid plans auto-fix; the free plan flags for manual review.
- **Profit tracking** (`/dashboard`) — imports orders with fee/COGS snapshots
  taken at sale time; 30-day KPIs, daily net-profit chart, per-item P&L,
  recent orders.

Plus: email/password auth (bcrypt + DB sessions), three billing tiers with
enforced listing limits (checkout is stubbed), and a settings area for the
eBay seller account connection.

## Stack

Next.js (App Router, server actions) · TypeScript · Tailwind · Prisma +
SQLite (swap the datasource to Postgres for production) · Vitest.

## Running locally

```bash
npm install
npm run db:push     # create/update the SQLite schema
npm run db:seed     # demo account with a month of activity
npm run dev
```

Log in as **demo@sellpilot.dev / demo1234** (Pro plan, seeded data), or
register a fresh account and walk the flow: connect eBay in Settings (sandbox)
→ import from Sourcing → generate drafts → publish → run sync → import orders.

```bash
npm test            # unit + DB integration tests (uses prisma/test.db)
npm run typecheck
npm run lint
npm run build
```

## Sandbox vs. production

All external integrations sit behind interfaces with mock implementations, so
the whole app works offline with zero credentials:

| Integration | Interface | Mock today | Real implementation |
| --- | --- | --- | --- |
| Amazon product pages | `ProductPageScraper` (`src/lib/mirror/scraper.ts`) | Deterministic fabricated product per ASIN | Amazon PA-API or a scraping API (Rainforest, Oxylabs); swap in `src/lib/mirror/index.ts` |
| Supplier/market data | `SupplierProvider` (`src/lib/sourcing/provider.ts`) | Deterministic 35-product catalog with daily stock/cost drift | CJ Dropshipping, AutoDS-style feed, or Zik-style analytics; swap in `src/lib/sourcing/index.ts` |
| eBay Sell APIs | `EbayClient` (`src/lib/ebay/client.ts`) | Validates like eBay, mints ids, fabricates deterministic orders | eBay Inventory + Fulfillment APIs with OAuth; swap in `src/lib/ebay/index.ts`; needs `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` |
| Payments | `changePlan` action (`src/lib/actions/billing.ts`) | Instant plan switch, no charge | Stripe Checkout + webhooks; needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

The eBay "Connect" button in Settings stores a sandbox placeholder; wired for
replacement by the real OAuth consent redirect.

## Architecture notes

- Money is integer cents everywhere; fee model centralized in `src/lib/fees.ts`
  (13.25% final value + $0.30/order, US managed payments).
- Orders snapshot fees/COGS at import so P&L history is stable under later
  cost/fee changes.
- Sync detection is pure (`src/lib/sync/detect.ts`) and unit-tested; the
  engine (`src/lib/sync/engine.ts`) orchestrates DB + eBay writes and
  supersedes stale issues instead of piling up duplicates.
- SQLite-friendly schema: string enums (values in `src/lib/types.ts`),
  JSON-as-text with typed mappers.

## Known limitations (deliberate v1 scope cuts)

- Sync issue history is pragmatic, not audit-grade: a persisting issue is
  superseded (old row deleted) each run, and issues whose condition cleared on
  its own are marked FIXED rather than a distinct "expired" state.
- No password reset/change flow and no login rate limiting yet.
- `planRenewsAt` is display-only until real billing lands (no renewal or
  auto-downgrade job).
- Order statuses SHIPPED/REFUNDED exist in the schema and P&L logic, but no
  flow sets them until the real eBay order import lands.
- Daily chart buckets use UTC day boundaries, not the seller's timezone.
