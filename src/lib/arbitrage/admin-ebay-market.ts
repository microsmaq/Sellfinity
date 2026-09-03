import "server-only";

import {
  countdownConfigured,
  researchCountdownMarket,
  searchCountdownProducts,
} from "@/lib/ebay/countdown";
import {
  getEbayProductByInput,
  researchEbayMarket,
  searchEbayProducts,
} from "@/lib/ebay/market";
import { ebayLegacyItemIdFromInput } from "@/lib/ebay/item-input";

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

export async function getAdminEbayProductByInput(input: string) {
  try {
    return await getEbayProductByInput(input);
  } catch (directError) {
    const legacyId = ebayLegacyItemIdFromInput(input);
    if (!legacyId) throw directError;
    try {
      const candidates = await searchAdminEbayProducts(legacyId, 50);
      const exact = candidates.find((candidate) => {
        const numericId = candidate.itemId.includes("|") ? candidate.itemId.split("|")[1] : candidate.itemId;
        return numericId === legacyId;
      });
      if (exact) return exact;
    } catch {
      // Preserve the direct item lookup error because it is more actionable.
    }
    throw directError;
  }
}
