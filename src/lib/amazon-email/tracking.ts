import "server-only";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayCarrierCode, normalizeTrackingNumber, remoteFulfillmentLookupKeys, trackingAppliesToAsin } from "./tracking-utils";

export type TrackingUploadResult = {
  eligible: number;
  uploaded: number;
  failed: number;
};

/**
 * Upload Amazon tracking only when attribution is unambiguous:
 * - the shipment email names the matched ASIN, or the purchase has one item;
 * - the Amazon ASIN exactly matches the listing source SKU;
 * - the local eBay sale maps to a currently unfulfilled eBay line.
 */
export async function uploadAmazonTrackingToEbay(userId: string): Promise<TrackingUploadResult> {
  const candidates = await db.order.findMany({
    where: { userId, ebayTrackingSyncedAt: null, amazonPurchaseItem: { isNot: null } },
    include: {
      listing: { include: { product: { select: { sku: true } } } },
      amazonPurchaseItem: { include: { purchase: { include: { items: { select: { id: true } } } } } },
    },
  });
  if (!candidates.length) return { eligible: 0, uploaded: 0, failed: 0 };

  const ebay = await getEbayClientForUser(userId);
  const remoteOrders = await ebay.getUnfulfilledOrders(userId);
  const remoteLines = new Map(
    remoteOrders.flatMap((order) => order.lines.flatMap((line) =>
      remoteFulfillmentLookupKeys(order.orderId, line.lineItemId, order.lines.length).map((key) => [
        key,
        { orderId: order.orderId, line },
      ] as const),
    )),
  );

  let eligible = 0;
  let uploaded = 0;
  let failed = 0;
  for (const order of candidates) {
    const item = order.amazonPurchaseItem;
    if (!item) continue;
    const purchase = item.purchase;
    const rawTracking = purchase.trackingNumber;
    if (!rawTracking || !["SHIPPED", "DELIVERED"].includes(purchase.status)) continue;
    if (!item.asin || item.asin.toUpperCase() !== order.listing.product.sku.toUpperCase()) continue;
    if (!trackingAppliesToAsin(purchase.trackingAsinsJson, purchase.items.length, item.asin)) continue;
    const remote = remoteLines.get(order.ebayOrderId);
    if (!remote) continue;

    const trackingNumber = normalizeTrackingNumber(rawTracking);
    if (trackingNumber.length < 8 || trackingNumber.length > 30) continue;
    const shippingCarrierCode = ebayCarrierCode(purchase.carrier, trackingNumber);
    eligible++;
    try {
      await ebay.createShippingFulfillment(userId, {
        orderId: remote.orderId,
        lineItemId: remote.line.lineItemId,
        quantity: Math.min(order.quantity, remote.line.quantity),
        trackingNumber,
        shippingCarrierCode,
      });
      await db.order.update({ where: { id: order.id }, data: {
        status: "SHIPPED",
        sourcingStatus: purchase.status,
        ebayTrackingNumber: trackingNumber,
        ebayTrackingCarrier: shippingCarrierCode,
        ebayTrackingSyncedAt: new Date(),
        ebayTrackingSyncError: null,
      } });
      uploaded++;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "eBay tracking update failed";
      await db.order.update({ where: { id: order.id }, data: { ebayTrackingSyncError: message } });
      failed++;
    }
  }
  return { eligible, uploaded, failed };
}
