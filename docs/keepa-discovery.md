# Keepa bestseller discovery

Admin entry: Product intelligence → **Keepa bestseller import**
(`/admin/arbitrage/keepa`). Seller accounts cannot access its page, actions or
saved provider snapshots. It does not change the seller refresh/mirroring flows.

## Setup and limits

1. Add `KEEPA_API_KEY` to the server environment (never a `NEXT_PUBLIC_` variable).
2. Deploy the included Prisma migration. No browser helper update is required.
3. The first authenticated scheduler run with a configured Keepa key automatically
   starts discovery, loads root categories once (1 token), and queues the physical
   product categories. Digital download/app/software roots are excluded. This
   initialization runs once: later pauses and redeployments do not re-enable it.
   Existing manual category choices are respected. The default budget is 28,800 tokens/day, matching the
   tokens generated at 20/min over 24 hours. Existing saved custom budgets are
   not increased automatically; use **Use full 20/min allowance** if desired.
4. Deploy on **Vercel Pro** with `CRON_SECRET` configured. The included cron
   invokes `/api/cron/keepa-discovery` every minute. This schedule is unsupported
   on Hobby and will fail deployment there. Do not upgrade the hosting plan
   without approval. No external scheduler subscription is required on Pro.
5. Imports run without an open browser or running
   personal computer. The page only polls saved progress; it does not drive the
   worker. **Server scheduler responding** and its last-check timestamp confirm
   recent authenticated cron execution (not a guarantee that Keepa is healthy).

The admin dashboard has a live **Amazon bestseller imports** card: actual products
added today and lifetime, queued ASINs, skipped known/repeated entries, review
counts, tokens, scheduler heartbeat, and a seven-day additions chart (Pacific
time). It refreshes read-only progress every 15 seconds; closing it has no effect
on the worker. Detailed category progress and pause/resume controls remain in
Product intelligence → Keepa bestseller import.

Each invocation drains productive units for up to a 40-second soft deadline
and 80 steps, returning immediately when waiting for tokens, paused, complete
or another worker holds the lease. A network call already started can take
another 50 seconds plus its database save. The function has a 180-second hard
limit. Per-step leases, reservations and owner-fenced responses prevent concurrent
cron invocations from issuing the same queued request. No sleeping functions
wait for a refill. The next scheduled tick resumes from the saved checkpoint.
Vercel function/database usage charges still apply; no zero-cost guarantee is made.

No Keepa key is bundled. Tests mock the provider: they do not spend API credits.
The server uses one US marketplace queue and a conservative ceiling of 20
refill tokens/minute, capped by the provider's reported lower rate/balance. This
does not coordinate other applications using the same API key. Keepa can still
reject a request if another application consumed the balance; HTTP 429 saves a
refill wait rather than retrying rapidly.

## How credits are protected

- Bestsellers: one 50-token request per selected category. Save the entire
  returned list before doing anything else. No artificial 50/100/1,000-item cap.
  Root lists can contain up to 500,000 ASINs; subcategories up to 10,000. The list
  describes Keepa sales-rank evidence, not a guarantee of storefront ranking,
  exact unit sales or complete Amazon coverage. One representative variation per
  family is requested (`variations=0`); uniqueness is by ASIN, not product family.
- Expand saved lists in 1,000-ASIN database chunks. Query all catalog statuses,
  including archived/published/pending, before adding new ASINs to a globally
  unique durable queue. Cross-category repeats and previously attempted ASINs
  never become new detail requests just because a list is refreshed.
  Each newly fetched category is primed before fetching every remaining list,
  so products start arriving sooner. Once its prepared ASINs are drained, the
  worker rotates through the remaining categories, then expands cached lists.
- Recheck the catalog immediately before paid detail requests. Fetch at most 20
  new ASINs per request and only as many as the remaining tokens/budget allow.
  A concurrent browser/manual import between this check and the network request
  cannot be made atomic with the remote provider; the ASIN constraint still
  prevents a duplicate catalog entry or overwrite.
- Product requests use `update=1`, `stats=90`, `days=90`, `history=1`, `aplus=1`,
  `videos=1`. Normally 1 token/ASIN, with no paid offers, rating, stock or Buy Box
  add-ons. Save the entire returned product object before mapping/importing.
  Titles, descriptions, features, image gallery, categories and variants map to
  catalog fields. Returned identifiers, dimensions, A+, videos and historical
  data remain in the saved snapshot, downloadable by an admin without another
  API call. Some of these optional fields may not exist in Keepa's response.
- Do not invent missing content, free shipping, stock or freshness. Shipping
  and general marketplace availability remain unverified until an admin browser
  check or other trusted refresh. Standard products enter PENDING research;
  parent/invalid/inaccessible products are held for review, not published. No
  existing matches, catalog products, listings or locked prices are overwritten.
- Reserve token cost before sending; reconcile with Keepa's reported consumption.
  An interrupted request or uncertain provider response is held, not silently
  retried. The admin must confirm possible duplicate charges. Saved responses can
  be imported repeatedly without a new paid request. The total counter includes
  conservative reservations for requests whose consumption cannot be confirmed.

Temporary network/save interruptions and HTTP 5xx responses trigger a five-minute
backoff. Their uncertain ASINs/lists are held without resubmission, while other
new queued ASINs can continue unattended after the wait. Permanent request/key
errors pause the job for administrator attention. HTTP 429 waits for a refill.
No new paid request is made merely to keep spending when the queue is exhausted;
select additional categories or explicitly refresh completed bestseller lists to
discover additional candidates. Continuous scheduling maximizes opportunities
to use tokens, but outages, missing data and an empty queue can still leave tokens
unused. Bestseller-list calls also consume part of the daily allowance.

Saved lists are reused indefinitely by default; fresh list retrieval requires
explicit confirmation of another potential 50 tokens/category. MISSING and
REVIEW product responses are not automatically requested again.

## Provider terms and provenance

Snapshots retain source `KEEPA`, ASIN, marketplace and fetched time so provider
data can be located for retention/removal obligations. Caching is subject to
the subscription and current Keepa terms; it is not a permanent redistribution
right. Review retention requirements if the subscription ends (current terms
require removal within 60 days, subject to stated exceptions). No raw-data resale
or feed is implemented. No automatic provider-data purge is implemented.

Primary references:

- https://keepa.com/api-docs/best-sellers.html
- https://keepa.com/api-docs/product.html
- https://keepa.com/api-docs/product-object.html
- https://keepa.com/api-docs/request-basics.html
- https://keepa.com/api-docs/category-lookup.html
- https://keepa.com/#!terms
- https://vercel.com/docs/cron-jobs/usage-and-pricing
