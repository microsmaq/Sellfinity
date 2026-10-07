# Sellfinity Amazon Tracking Helper

## Install in Chrome

1. Download and unzip `sellfinity-tracking-helper.zip`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped `sellfinity-tracking-helper` folder.

## Use

1. Sign in to Amazon in Chrome.
2. Open Sellfinity Fulfillment.
3. Click **Open Amazon tracking** for an order.
4. When a supported tracking number appears, the extension returns to Sellfinity and fills that order's tracking field.
5. Review the number and click **Save & mark shipped**.

You can also click **Refresh Amazon & eBay** in Sellfinity. Version 1.2.0 checks
all unresolved Amazon tracking links in the background, including links found
by the email scan during that same refresh, and saves every tracking ID it
finds. Its progress is shown inside the animated Fulfillment refresh panel.
Keep Amazon signed in while the check runs.

Version 1.3.0 also supports **Check Amazon prices** in Fulfillment and the
optional **Check live Amazon prices** step in Listings Smart Sync. It opens one
signed-in Amazon page per unique product in the requested scope, reads the current
item price and any clearly displayed shipping charge, then saves the costs and
recalculates the order profit. If Amazon does not clearly show shipping, the
existing shipping amount is preserved rather than incorrectly assuming it is
free.

Version 1.3.2 adds a live control center when you click the extension icon.
It shows price and tracking progress, found/error counts, remaining work, and
separate stop buttons. Sellfinity also shows a stop button during each active
check. The Amazon reader now waits for the real product page instead of treating
the temporary blank loading tab as a failed read.

Version 1.3.3 reports progress to Sellfinity immediately, before Amazon tabs
finish opening. This prevents slow tab launches from being incorrectly shown
as a missing or outdated helper.

Version 1.3.4 distinguishes confirmed Amazon unavailability from sign-in,
CAPTCHA, and temporary read failures. Confirmed unavailable products are saved
as out of stock in Sellfinity and can be ended on eBay when the Smart Sync
end-unavailable option is selected.

Version 1.3.5 enables the same signed-in price, shipping, and availability
checker in Admin Product Intelligence for selected products or the full shared
catalog. These admin checks do not consume Rainforest credits.

Version 1.3.6 keeps large price-check queues alive for up to 12 hours and
refreshes the active-run heartbeat after every product. This prevents catalog
checks with thousands of products from silently becoming idle after 45 minutes.

Version 1.3.7 retries tracking extraction after Amazon finishes navigation and
waits for Sellfinity to acknowledge the result before closing the reader. This
prevents visible tracking IDs from being lost during a fast tab-opening race.

After updating the extension files, click the extension's **Reload** button on
`chrome://extensions` before trying it again.

The extension does not use clipboard access. It only reads supported
Amazon/carrier tracking pages opened from Sellfinity and submits tracking to
the matching fulfillment row.

## Automated content repair (v1.6.5)

Open the helper → Repair missing catalog content. Choose products per run,
enable daily repair and save the local start time, or run a repair immediately.
Remain signed in to Sellfinity as admin and keep Chrome running on an awake PC.
The worker revisits incomplete saved products, prioritizing never-checked items
then oldest content-check attempts. It fills content only and leaves price,
availability and approved matches untouched. Uses existing workload limits,
Stop/Resume controls and verification pauses. No paid product research calls.
If Amazon does not expose usable copy, the warning remains for manual review.

## Rich catalog imports (v1.6.5)

Product captures now include standard and A+ description text, feature bullets,
and up to 12 deduplicated gallery photo URLs at their original resolution.
Amazon's image-only text cannot be read as a description; incomplete products
are flagged for review instead of inventing details. Images are stored as URLs,
not downloaded files. No additional Amazon page requests or AI credits are used.

Re-capturing an existing ASIN fills missing descriptions and bullets and adds
gallery images without changing its price, availability or approved match.
The popup reports these records as enriched. Bestseller discovery still skips
existing ASINs. Manual/JSON/CSV imports can also supply this product content.

## Amazon workload controls (v1.6.5)

Price checks record a shared per-ASIN attempt timestamp in Sellfinity when the
helper starts opening the page, even if the read later fails or is blocked.
The next queue prioritizes never-checked, then oldest-checked items. Failed
attempts have no 24-hour exclusion: they remain eligible after other items have
had their turn. The existing freshness option only skips verified price or
availability updates within 24 hours. Attempt history is separate from those updates:
failed checks do not refresh prices or mark a product unavailable. Unopened
queued items are not stamped as checked. Manual scans can disable the skip option.

The popup provides editable limits for page spacing, a daily cap, batch size and
scheduled breaks. Defaults: one helper-opened Amazon page at a time, 60 seconds
between starts, 100 pages per local day, and a 15-minute break every 20 pages.
These limits apply to bulk prices/tracking and automated catalog discovery.
They reduce load, but do not disguise automation or guarantee Amazon access.
Manually opened quick-check pages are not rate-controlled by the helper.

Pause/Resume saves the queue without discarding completed results. Scheduled
waits and daily-cap waits continue through Chrome alarms while Chrome stays
open. Queued bulk work is retained locally for up to seven days. Keep the
originating Sellfinity tab open; if it is closed, stop that old run and restart
the task in Sellfinity (freshness filtering preserves completed updates).

CAPTCHA, account verification and access-denied pages pause Amazon work and
preserve the challenged tab. Every hour the helper inspects that existing tab
without reloading it or opening more Amazon pages. Work resumes only if the page
is readable again; otherwise it stays paused. CAPTCHA is never solved or bypassed.
If Amazon requires human verification, complete it yourself and use Resume saved
work. Keep the challenged tab open. Blocked pages never change
price/availability or trigger delisting. Temporary read failures back off for up
to 15 minutes, then remaining items continue automatically, even after repeated
failures. User pauses always require manual resume. The page reader retains its
bounded startup retries; failed products are not retried indefinitely.

Reload the unpacked helper after replacing it with v1.6.5, then refresh the
Sellfinity tab. Existing daily schedules are retained. Browser-local page limits
are not a coordinated cap across multiple computers.

## Daily unattended admin checks (v1.4.0)

Install/reload this version on the dedicated computer. Sign in to Amazon and
Sellfinity as an administrator using that Chrome profile. Open the helper popup,
enable **Run automatically every day**, choose a local start time (default
02:00), and click **Save daily schedule**. **Run catalog check now** starts the
same scan immediately. Scheduled checks cover stale or never-checked products
in the non-archived admin catalog, always skipping data checked within the last
24 hours (including resumed runs), regardless of the manual checkbox. They
save prices, shipping and confirmed unavailability to the shared
database using the signed-in browser, without Rainforest credits.

Leave Chrome running and keep the computer awake with a network connection.
The schedule catches up after startup if today's time was missed. If Chrome
closed mid-scan, the next startup checks remaining records, skipping records
updated within the last 24 hours. Check progress and the last saved result in
the popup. Stop price check cancels the current scan; disable the daily schedule
to prevent the next day's run. Amazon CAPTCHA and expired sign-ins require
manual attention. Unreadable or blocked pages do not mark items unavailable.

For a seller's dedicated computer, select **User: sync prices and delist
unavailable** in the popup, enable the schedule and save the time. This checks
all active tracked listings against the shared admin catalog and applies the
seller's pricing strategy, advertising rate and profit settings to eBay.
No Amazon tabs or Rainforest requests are used for the user schedule. Missing
admin records stay unchanged for review. Confirmed unavailable sources are
delisted even for Verified Winners and price locks; those locks only prevent
automatic price changes on available products. Relisting and image changes
remain manual. Progress and results appear in Listings and Publishing History.
Keep this Chrome profile signed in as the intended seller with eBay connected.
Set the seller schedule after the admin computer normally finishes its scan.

## No-credit catalog imports (v1.5.0)

In Admin → Product intelligence, open **Import Amazon products**. Enter fields
manually, upload/paste CSV using the template, or paste a JSON array. An AI
computer-use agent can populate the same form. Review the preview and save.
Blank shipping means unknown; 0 means verified free shipping. Existing ASINs
are skipped unless you explicitly choose to replace them. Replacing returns
the record to Pending review and clears previous eBay research.

With an Amazon product tab open, click **Add Amazon product to Sellfinity** in
the extension popup. It captures the selected ASIN, title, brand, variant,
images, bullets, price, shipping and availability, then saves through your
signed-in admin import page. **Collect this bestseller page** captures ranked
cards on the open category page, skips ASINs already saved, and reads new
product pages before saving. Bestseller rank is recorded with category, source
URL and capture time; it is never treated as an exact sales count. Imports use
no Rainforest, Countdown or eBay research calls and remain Pending review.

For unattended discovery, expand **Daily bestseller discovery**, enter up to
20 Amazon Best Sellers category/page URLs, set a time and a new-product target,
then save. Include the page 2 URLs if you want those results too. The scan stops
at the target or after exhausting those pages. The catalog import progress is
saved across browser restarts; use Stop or Resume in the popup. Keep Chrome
awake and signed in as an admin. CAPTCHA pauses the import with the Amazon tab
left open for manual completion. Research and publish eBay matches separately
from Product intelligence after reviewing captured information.
