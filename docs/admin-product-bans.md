# Admin product bans

Product Intelligence supports **Ban & remove** per product and **Ban & remove selected** for bulk selections. The confirmation explains that every store is affected.

A ban retains the ASIN and `bannedAt` in the shared catalog, removes its Arbitrage Finder research rows, and marks seller source stock unavailable. Banned products are excluded from normal catalog results; use the **Banned products** filter to inspect them. Historical orders, fulfillment and profit records are preserved.

On the next user listing refresh or scheduled Smart Sync, live listings using a banned ASIN are queued first for eBay delisting, including when ordinary unavailable-source delisting is unchecked. Banned items are included beyond the ordinary 1,000-item sync cap. Selected-only runs continue to respect the selected scope. An eBay failure leaves the listing active and reports the error for retry; local removal follows successful or already-ended confirmation. Inventory sync also enforces bans. Successful removals use `ADMIN_BANNED`, so automatic recovery will not relist them.

Saved drafts, URL mirroring and listing recovery reject banned sources. Amazon price checks and reimports do not clear `bannedAt`; a new in-stock snapshot cannot restore a banned source.

Deployment requires migration `20261023090000_admin_product_bans`. No browser extension update is needed. This migration only adds a nullable column and index; it does not ban or remove any existing products.
