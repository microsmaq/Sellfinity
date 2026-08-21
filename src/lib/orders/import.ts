import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { ebayFeeCents } from "@/lib/fees";
import { deliveryAddressFingerprint } from "@/lib/amazon-email/address-match";
import { ORDER_IMPORT_LOOKBACK_DAYS } from "./import-window";

// eBay cancellations can be requested well after the original sale. Recheck
// the full 90-day Fulfillment API window so older locally stored orders do not
// remain actionable after eBay has cancelled or refunded them.
const LOOKBACK_MS = ORDER_IMPORT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

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

    const affectsInventory = !remote.cancelled && remote.status !== "REFUNDED";
    const newQuantity = affectsInventory
      ? Math.max(0, listing.quantity - remote.quantity)
      : listing.quantity;
    try {
      // One transaction per order: the record and the quantity mirror land
      // together, and the unique (userId, ebayOrderId) constraint is the
      // dedupe — a concurrent import of the same order rolls back both writes.
      await db.$transaction(async (tx) => {
        await tx.order.create({
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
            shippingRecipientName: remote.shippingRecipientName ?? null,
            shippingAddressFingerprint: deliveryAddressFingerprint(remote.shippingAddressLine1, remote.shippingPostalCode),
            saleDate: remote.saleDate,
            status: remote.status ?? "PAID",
            sourcingStatus: remote.cancelled
              ? "CANCELLED"
              : remote.status === "SHIPPED"
                ? "SHIPPED"
                : "NOT_PURCHASED",
          },
        });
        // Cancelled/refunded orders do not consume fulfillable inventory.
        if (affectsInventory) {
          await tx.listing.update({
            where: { id: listing.id },
            data: { quantity: newQuantity },
          });
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        // Existing rows are refreshed too, so an eBay cancellation that
        // happened after the first import immediately leaves Needs action.
        await db.order.updateMany({
          where: { userId, ebayOrderId: remote.ebayOrderId },
          data: {
            ...(remote.status && { status: remote.status }),
            ...(remote.cancelled && {
              sourcingStatus: "CANCELLED",
              ebayTrackingSyncError: null,
            }),
            ...(remote.shippingRecipientName && { shippingRecipientName: remote.shippingRecipientName }),
            ...(remote.shippingAddressLine1 && remote.shippingPostalCode && {
              shippingAddressFingerprint: deliveryAddressFingerprint(remote.shippingAddressLine1, remote.shippingPostalCode),
            }),
          },
        });
        continue; // already imported
      }
      throw e;
    }
    if (affectsInventory) listing.quantity = newQuantity;
    imported++;
  }
  return { imported };
}
