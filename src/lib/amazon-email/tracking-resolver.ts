import "server-only";
import { db } from "@/lib/db";
import { trackingFromPage } from "./tracking-resolver-utils";

export type TrackingResolutionResult = { examined: number; resolved: number; pending: number };
export type TrackingResolutionOptions = { retryFailed?: boolean };

const ALLOWED_TRACKING_HOST = /(^|\.)(?:amazon\.com|a\.co|amzn\.to|ups\.com|fedex\.com|usps\.com|dhl\.com|ontrac\.com)$/i;

function safeTrackingUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_TRACKING_HOST.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

async function fetchTrackingPage(initialUrl: URL): Promise<{ url: string; html: string }> {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; SellfinityFulfillment/1.0)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Amazon tracking redirect did not include a destination.");
      const next = safeTrackingUrl(new URL(location, current).toString());
      if (!next) throw new Error("Amazon tracking redirected to an unsupported destination.");
      current = next;
      continue;
    }
    return { url: current.toString(), html: (await response.text()).slice(0, 2_000_000) };
  }
  throw new Error("Amazon tracking redirected too many times.");
}

export async function resolveMissingAmazonTracking(
  userId: string,
  options: TrackingResolutionOptions = {},
): Promise<TrackingResolutionResult> {
  const purchases = await db.amazonPurchase.findMany({
    where: {
      userId,
      status: { in: ["SHIPPED", "DELIVERED"] },
      trackingNumber: null,
      trackingUrl: { not: null },
      ...(!options.retryFailed && { trackingLookupError: null }),
    },
    orderBy: { updatedAt: "desc" },
    take: 80,
  });
  const result: TrackingResolutionResult = { examined: purchases.length, resolved: 0, pending: 0 };
  async function resolveOne(purchase: typeof purchases[number]): Promise<"resolved" | "pending"> {
    const url = purchase.trackingUrl ? safeTrackingUrl(purchase.trackingUrl) : null;
    if (!url) {
      await db.amazonPurchase.update({ where: { id: purchase.id }, data: { trackingLookupError: "Amazon supplied an invalid tracking link." } });
      return "pending";
    }
    try {
      const page = await fetchTrackingPage(url);
      const tracking = trackingFromPage(page.url, page.html);
      if (!tracking) {
        const signInEvidence = `${page.url}\n${page.html.slice(0, 100_000)}`;
        const requiresSignIn = /sign[ -]?in|ap\/signin|authportal|nav-link-accountList/i.test(signInEvidence);
        await db.amazonPurchase.update({ where: { id: purchase.id }, data: {
          trackingLookupError: requiresSignIn
            ? "Amazon requires sign-in to reveal this tracking number. Open the tracking link to review it."
            : "Amazon has not exposed a carrier tracking number on this page yet.",
        } });
        return "pending";
      }
      await db.amazonPurchase.update({ where: { id: purchase.id }, data: {
        trackingNumber: tracking.trackingNumber,
        carrier: tracking.carrier ?? purchase.carrier,
        trackingResolvedAt: new Date(),
        trackingLookupError: null,
      } });
      return "resolved";
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 240) : "Amazon tracking lookup failed";
      await db.amazonPurchase.update({ where: { id: purchase.id }, data: { trackingLookupError: message } });
      return "pending";
    }
  }
  // Amazon redirect endpoints can be slow. A bounded batch keeps a manual
  // Fulfillment refresh responsive without flooding Amazon or carrier sites.
  for (let index = 0; index < purchases.length; index += 8) {
    const outcomes = await Promise.all(purchases.slice(index, index + 8).map(resolveOne));
    for (const outcome of outcomes) result[outcome]++;
  }
  return result;
}
