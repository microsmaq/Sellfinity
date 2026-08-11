"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { importOrders } from "@/lib/orders/import";
import { restockLowFulfillmentInventory, type AutoRestockResult } from "@/lib/orders/auto-restock";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayCarrierCode, normalizeTrackingNumber, remoteFulfillmentLookupKeys } from "@/lib/amazon-email/tracking-utils";

export async function submitManualOrderTracking(orderId: string, rawTrackingNumber: string) {
  const user = await requireUser();
  const trackingNumber = normalizeTrackingNumber(rawTrackingNumber);
  if (trackingNumber.length < 8 || trackingNumber.length > 30) {
    return { error: "Enter a valid tracking number containing 8 to 30 letters or numbers." };
  }

  const order = await db.order.findFirst({
    where: { id: orderId, userId: user.id },
    include: { amazonPurchaseItem: { include: { purchase: true } } },
  });
  if (!order) return { error: "Order not found." };
  if (["REFUNDED"].includes(order.status) || order.sourcingStatus === "CANCELLED") {
    return { error: "Tracking cannot be added to a cancelled or refunded order." };
  }

  const carrier = ebayCarrierCode(order.amazonPurchaseItem?.purchase.carrier ?? null, trackingNumber);

  // A delivered eBay order no longer needs a fulfillment update. Keep the
  // tracking number in Sellfinity so it remains visible without asking eBay
  // to modify a fulfillment that is already closed.
  if (order.sourcingStatus === "DELIVERED") {
    await db.order.update({
      where: { id: order.id },
      data: {
        ebayTrackingNumber: trackingNumber,
        ebayTrackingCarrier: carrier,
        ebayTrackingSyncedAt: null,
        ebayTrackingSyncError: null,
      },
    });
    revalidatePath("/orders");
    revalidatePath("/dashboard");
    return { trackingNumber, carrier, sourcingStatus: "DELIVERED", syncedToEbay: false };
  }

  try {
    const ebay = await getEbayClientForUser(user.id);
    const remoteOrders = await ebay.getUnfulfilledOrders(user.id);
    const candidates = remoteOrders.flatMap((remoteOrder) =>
      remoteOrder.lines.flatMap((line) =>
        remoteFulfillmentLookupKeys(remoteOrder.orderId, line.lineItemId, remoteOrder.lines.length)
          .includes(order.ebayOrderId)
          ? [{ remoteOrder, line }]
          : [],
      ),
    );
    if (candidates.length !== 1) {
      return { error: candidates.length > 1
        ? "This eBay order has multiple possible lines. Refresh the order before adding tracking."
        : "This order is no longer an open eBay fulfillment or could not be mapped safely." };
    }

    const [{ remoteOrder, line }] = candidates;
    await ebay.createShippingFulfillment(user.id, {
      orderId: remoteOrder.orderId,
      lineItemId: line.lineItemId,
      quantity: Math.min(order.quantity, line.quantity),
      trackingNumber,
      shippingCarrierCode: carrier,
    });
    const sourcingStatus = "SHIPPED";
    await db.order.update({ where: { id: order.id }, data: {
      status: "SHIPPED",
      sourcingStatus,
      ebayTrackingNumber: trackingNumber,
      ebayTrackingCarrier: carrier,
      ebayTrackingSyncedAt: new Date(),
      ebayTrackingSyncError: null,
    } });
    revalidatePath("/orders");
    revalidatePath("/dashboard");
    return { trackingNumber, carrier, sourcingStatus, syncedToEbay: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "eBay rejected the tracking update.";
    await db.order.updateMany({
      where: { id: order.id, userId: user.id },
      data: { ebayTrackingSyncError: message },
    });
    return { error: message };
  }
}

export async function setAutoRestockFulfilledListings(enabled: boolean) {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { autoRestockFulfilledListings: enabled },
  });
  let restock = null;
  let warning: string | null = null;
  if (enabled) {
    try {
      restock = await restockLowFulfillmentInventory(user.id);
    } catch (error) {
      warning = error instanceof Error ? error.message.slice(0, 200) : "The immediate eBay stock check failed.";
    }
  }
  revalidatePath("/orders");
  return { enabled, restock, warning };
}

export async function importOrdersNow(): Promise<
  { imported: number; restock: AutoRestockResult } | { error: string }
> {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { error: "Connect your eBay account in Settings before importing orders." };
  }
  const result = await importOrders(user.id);
  const restock = await restockLowFulfillmentInventory(user.id);
  revalidatePath("/dashboard");
  revalidatePath("/listings");
  revalidatePath("/orders");
  return { ...result, restock };
}
