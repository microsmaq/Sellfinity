import "server-only";

import {
  countdownConfigured,
  researchCountdownMarket,
  searchCountdownProducts,
} from "@/lib/ebay/countdown";
import {
  researchEbayMarket,
  searchEbayProducts,
} from "@/lib/ebay/market";

/** Countdown is deliberately reachable only from administrator research.
 * Seller listing refreshes continue to use eBay and shared stored metrics. */
export async function searchAdminEbayProducts(title: string, limit = 50) {
  if (countdownConfigured()) {
    try {
      return await searchCountdownProducts(title, limit);
    } catch (error) {
      console.error("Countdown admin search failed; using eBay Browse fallback", error);
    }
  }
  return searchEbayProducts(title, limit);
}

export async function researchAdminEbayMarket(
  title: string,
  referenceEbayListingId: string,
  options?: { allowReferenceFallback?: boolean },
) {
  if (countdownConfigured()) {
    try {
      return await researchCountdownMarket(title, referenceEbayListingId, options);
    } catch (error) {
      console.error("Countdown admin market research failed; using eBay Browse fallback", error);
    }
  }
  return researchEbayMarket(title, referenceEbayListingId, options);
}
