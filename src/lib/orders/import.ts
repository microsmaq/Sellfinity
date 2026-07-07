import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { ebayFeeCents } from "@/lib/fees";

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pull new orders from eBay and record them with fee/COGS snapshots.
 * Idempotent: orders are deduped on ebayOrderId, so we always request the
 * full lookback window — a narrower "since last import" window would
 * permanently miss orders for listings published between imports. Sold units
 * are mirrored onto the listing quantity (eBay decrements it server-side on
 * sale).
 */
export async function importOrders(
  userId: string,
  ebayClient?: EbayClient,
): Promise<{ imported: number }> {
  const ebay = ebayClient ?? (await getEbayClientForUser(userId));
  const since = new Date(Date.now() - LOOKBACK_MS);
  const remoteOrders = await ebay.getOrders(userId, since);
  if (remoteOrders.length === 0) return { imported: 0 };

  const listings = await db.listing.findMany({
    where: {
      userId,
      ebayListingId: { in: [...new Set(remoteOrders.map((o) => o.ebayListingId))] },
    },
    include: { product: { select: { costCents: true, shippingCostCents: true } } },
  });
  const byEbayId = new Map(listings.map((l) => [l.ebayListingId!, l]));

  let imported = 0;
  for (const remote of remoteOrders) {
    const listing = byEbayId.get(remote.ebayListingId);
    if (!listing) continue; // order for a listing we don't track

    const newQuantity = Math.max(0, listing.quantity - remote.quantity);
    try {
      // One transaction per order: the record and the quantity mirror land
      // together, and the unique (userId, ebayOrderId) constraint is the
      // dedupe — a concurrent import of the same order rolls back both writes.
      await db.$transaction([
        db.order.create({
          data: {
            userId,
            listingId: listing.id,
            ebayOrderId: remote.ebayOrderId,
            quantity: remote.quantity,
            salePriceCents: remote.salePriceCents,
            shippingChargedCents: remote.shippingChargedCents,
            // Prefer the fee eBay actually charged; estimate when absent.
            ebayFeeCents: remote.feeCents ?? ebayFeeCents(remote),
            shippingCostCents: listing.product.shippingCostCents,
            cogsCents: listing.product.costCents * remote.quantity,
            buyerUsername: remote.buyerUsername,
            saleDate: remote.saleDate,
          },
        }),
        // Mirror eBay's server-side quantity decrement.
        db.listing.update({
          where: { id: listing.id },
          data: { quantity: newQuantity },
        }),
      ]);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        continue; // already imported
      }
      throw e;
    }
    listing.quantity = newQuantity;
    imported++;
  }
  return { imported };
}
