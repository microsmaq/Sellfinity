import "server-only";

import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { AUTO_RESTOCK_TARGET, shouldAutoRestock } from "./auto-restock-policy";

export type AutoRestockResult = {
  checked: number;
  lowStock: number;
  restocked: number;
  failed: number;
};

/**
 * Refill sold, active listings from the live eBay quantity. Listings that
 * have never appeared in Fulfillment and quantities eBay does not expose are
 * deliberately ignored.
 */
export async function restockLowFulfillmentInventory(
  userId: string,
  ebayClient?: EbayClient,
): Promise<AutoRestockResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { autoRestockFulfilledListings: true },
  });
  if (!user?.autoRestockFulfilledListings) {
    return { checked: 0, lowStock: 0, restocked: 0, failed: 0 };
  }

  const tracked = await db.listing.findMany({
    where: {
      userId,
      status: "ACTIVE",
      ebayListingId: { not: null },
      orders: { some: {} },
    },
    select: { id: true, ebayListingId: true },
  });
  if (!tracked.length) return { checked: 0, lowStock: 0, restocked: 0, failed: 0 };

  const byEbayId = new Map(tracked.map((listing) => [listing.ebayListingId!, listing]));
  const ebay = ebayClient ?? await getEbayClientForUser(userId);
  const liveListings = await ebay.getSellerListings(userId);
  const eligible = liveListings.filter((listing) => byEbayId.has(listing.ebayListingId));
  const lowStock = eligible.filter((listing) => shouldAutoRestock(listing.quantity));

  let restocked = 0;
  let failed = 0;
  for (const live of lowStock) {
    const local = byEbayId.get(live.ebayListingId)!;
    try {
      await ebay.updateListing(live.ebayListingId, { quantity: AUTO_RESTOCK_TARGET });
      await db.listing.update({ where: { id: local.id }, data: { quantity: AUTO_RESTOCK_TARGET } });
      restocked++;
    } catch {
      failed++;
    }
  }

  return { checked: eligible.length, lowStock: lowStock.length, restocked, failed };
}
