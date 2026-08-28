import "server-only";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayCarrierCode, normalizeTrackingNumber, remoteFulfillmentLookupKeys, storedFulfillmentIdentity, trackingAppliesToAsin, trackingCandidateForUpload } from "./tracking-utils";

export type TrackingUploadResult = {
  eligible: number;
  uploaded: number;
  savedLocally: number;
  failed: number;
};

/**
 * Upload tracking saved directly on an order, or Amazon tracking when
 * attribution is unambiguous:
 * - the shipment email names the matched ASIN, or the purchase has one item;
 * - the Amazon ASIN exactly matches the listing source SKU;
 * - the local eBay sale maps to a currently unfulfilled eBay line.
 */
export async function uploadAmazonTrackingToEbay(userId: string): Promise<TrackingUploadResult> {
  const candidates = await db.order.findMany({
    where: {
      userId,
      ebayTrackingSyncedAt: null,
      status: { notIn: ["REFUNDED", "SHIPPED"] },
      sourcingStatus: { not: "CANCELLED" },
      OR: [
        { ebayTrackingNumber: { not: null } },
        { amazonPurchaseItem: { isNot: null } },
      ],
    },
    include: {
      listing: { include: { product: { select: { sku: true } } } },
      amazonPurchaseItem: { include: { purchase: { include: { items: { select: { id: true } } } } } },
    },
  });
  if (!candidates.length) return { eligible: 0, uploaded: 0, savedLocally: 0, failed: 0 };

  let eligible = 0;
  let uploaded = 0;
  const savedLocally = 0;
  let failed = 0;

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

  for (const order of candidates) {
    const item = order.amazonPurchaseItem;
    const purchase = item?.purchase;
    const asinMatches = !!item?.asin && item.asin.toUpperCase() === order.listing.product.sku.toUpperCase();
    const amazonAttributionSafe = !!item && !!purchase && asinMatches
      && trackingAppliesToAsin(purchase.trackingAsinsJson, purchase.items.length, item.asin!);
    const candidate = trackingCandidateForUpload({
      storedTrackingNumber: order.ebayTrackingNumber,
      storedCarrier: order.ebayTrackingCarrier,
      amazonTrackingNumber: purchase?.trackingNumber,
      amazonCarrier: purchase?.carrier,
      amazonStatus: purchase?.status,
      amazonAttributionSafe,
    });
    if (!candidate) continue;
    const remote = remoteLines.get(order.ebayOrderId);
    // Older orders can disappear from eBay's open-order feed before their
    // locally saved tracking was uploaded. The stored composite identity is
    // still sufficient to address that exact eBay line safely.
    const fallback = remote ? null : storedFulfillmentIdentity(order);
    if (!remote && !fallback) continue;

    const trackingNumber = normalizeTrackingNumber(candidate.trackingNumber);
    if (trackingNumber.length < 8 || trackingNumber.length > 30) continue;
    const shippingCarrierCode = ebayCarrierCode(candidate.carrier, trackingNumber);
    eligible++;
    try {
      await ebay.createShippingFulfillment(userId, {
        orderId: remote?.orderId ?? fallback!.orderId,
        lineItemId: remote?.line.lineItemId ?? fallback!.lineItemId,
        quantity: remote ? Math.min(order.quantity, remote.line.quantity) : Math.max(1, order.quantity),
        trackingNumber,
        shippingCarrierCode,
      });
      await db.order.update({ where: { id: order.id }, data: {
        status: "SHIPPED",
        // A tracking number proves shipment, not delivery. Preserve Delivered
        // only when Amazon independently supplied a real delivery status.
        sourcingStatus: purchase?.status === "DELIVERED" ? "DELIVERED" : "SHIPPED",
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
  return { eligible, uploaded, savedLocally, failed };
}
