"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { importOrders } from "@/lib/orders/import";
import { restockLowFulfillmentInventory, type AutoRestockResult } from "@/lib/orders/auto-restock";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayCarrierCode, normalizeTrackingNumber, remoteFulfillmentLookupKeys } from "@/lib/amazon-email/tracking-utils";
import { sourcingStatusForAmazonPurchase } from "@/lib/amazon-email/status";
import { fulfillmentIdentityEvidence, fulfillmentProductFallbackAllowed, fulfillmentTitleSimilarity } from "@/lib/amazon-email/title-match";

export async function linkAmazonPurchase(orderId: string, rawAmazonOrderId: string) {
  const user = await requireUser();
  const amazonOrderId = rawAmazonOrderId.trim();
  if (!/^\d{3}-\d{7}-\d{7}$/.test(amazonOrderId)) {
    return { error: "Enter an Amazon order number in the format 123-1234567-1234567." };
  }

  const [order, purchase] = await Promise.all([
    db.order.findFirst({
      where: { id: orderId, userId: user.id },
      include: { amazonPurchaseItem: true, listing: { include: { product: true } } },
    }),
    db.amazonPurchase.findUnique({
      where: { userId_amazonOrderId: { userId: user.id, amazonOrderId } },
      include: { items: { include: { matchedOrder: true } } },
    }),
  ]);
  if (!order) return { error: "Fulfillment order not found." };
  if (order.amazonPurchaseItem) return { error: "This fulfillment order already has an Amazon purchase attached." };
  if (!purchase) return { error: "Amazon order not found yet. Click Refresh, then try again." };

  const strongItems = purchase.items.filter((item) => {
    const exactAsin = !!item.asin && item.asin.toUpperCase() === order.listing.product.sku.toUpperCase();
    const titleScore = fulfillmentTitleSimilarity(order.listing.title, item.title);
    return exactAsin || titleScore >= 85;
  });
  if (strongItems.length !== 1) {
    return { error: strongItems.length
      ? "This Amazon order contains multiple possible matching items and cannot be linked safely."
      : "The product in this Amazon order does not match the fulfillment listing." };
  }
  const item = strongItems[0];
  if (item.matchedOrderId) {
    return { error: `This Amazon purchase is already attached to ${item.matchedOrder?.ebayOrderId ?? "another fulfillment order"}. Use Correct Amazon match there.` };
  }

  const exactAsin = !!item.asin && item.asin.toUpperCase() === order.listing.product.sku.toUpperCase();
  const titleScore = fulfillmentTitleSimilarity(order.listing.title, item.title);
  const identity = fulfillmentIdentityEvidence({
    ebayRecipientName: order.shippingRecipientName,
    amazonRecipientName: purchase.recipientName,
    ebayAddressFingerprint: order.shippingAddressFingerprint,
    amazonAddressFingerprint: purchase.deliveryAddressFingerprint,
  });
  const productFallback = fulfillmentProductFallbackAllowed({
    exactAsin,
    titleScore,
    purchaseDate: purchase.purchasedAt,
    saleDate: order.saleDate,
    ebayAddressFingerprint: order.shippingAddressFingerprint,
    amazonAddressFingerprint: purchase.deliveryAddressFingerprint,
  });
  if (!identity.compatible && !productFallback) {
    return { error: "The Amazon delivery identity or purchase date conflicts with this eBay order, so it was not linked." };
  }
  if (!productFallback && identity.strength === 0) {
    return { error: "There is not enough date, recipient, or address evidence to link this order safely." };
  }

  const status = sourcingStatusForAmazonPurchase(purchase.status);
  await db.$transaction([
    db.amazonPurchaseItem.update({
      where: { id: item.id },
      data: {
        asin: item.asin ?? order.listing.product.sku.toUpperCase(),
        matchedOrderId: order.id,
        matchConfidence: exactAsin ? 100 : titleScore,
        matchReason: "Manually linked by Amazon order number after product, date, and delivery evidence validation.",
      },
    }),
    db.order.update({
      where: { id: order.id },
      data: { sourcingStatus: status, amazonMatchedAt: new Date() },
    }),
  ]);
  revalidatePath("/orders");
  revalidatePath("/dashboard");
  return { linked: true as const, amazonOrderId, sourcingStatus: status };
}

export async function reassignAmazonPurchase(sourceOrderId: string, targetOrderId: string) {
  const user = await requireUser();
  if (sourceOrderId === targetOrderId) return { error: "Choose a different fulfillment order." };
  const [source, target] = await Promise.all([
    db.order.findFirst({
      where: { id: sourceOrderId, userId: user.id },
      include: { amazonPurchaseItem: { include: { purchase: true } }, listing: { include: { product: true } } },
    }),
    db.order.findFirst({
      where: { id: targetOrderId, userId: user.id },
      include: { amazonPurchaseItem: true, listing: { include: { product: true } } },
    }),
  ]);
  if (!source?.amazonPurchaseItem) return { error: "The original order no longer has an Amazon purchase attached." };
  if (!target) return { error: "The destination order was not found." };
  if (target.amazonPurchaseItem) return { error: "The destination already has an Amazon purchase attached." };
  if (source.listing.product.sku.toUpperCase() !== target.listing.product.sku.toUpperCase()) {
    return { error: "Amazon purchases can only be moved between orders for the same ASIN." };
  }
  if (source.ebayTrackingSyncedAt) {
    return { error: "Tracking was already sent to eBay for this match. Contact support before moving it." };
  }
  const status = sourcingStatusForAmazonPurchase(source.amazonPurchaseItem.purchase.status);
  await db.$transaction([
    db.amazonPurchaseItem.update({
      where: { id: source.amazonPurchaseItem.id },
      data: {
        matchedOrderId: target.id,
        matchReason: "Manually reassigned to the correct repeated-ASIN eBay order.",
        matchConfidence: 100,
      },
    }),
    db.order.update({
      where: { id: source.id },
      data: {
        sourcingStatus: "NOT_PURCHASED",
        amazonMatchedAt: null,
        profitProtectionStatus: null,
        profitProtectionReviewedAt: null,
        profitProtectionOldPriceCents: null,
        profitProtectionNewPriceCents: null,
        profitProtectionError: null,
      },
    }),
    db.order.update({
      where: { id: target.id },
      data: { sourcingStatus: status, amazonMatchedAt: new Date() },
    }),
  ]);
  revalidatePath("/orders");
  revalidatePath("/dashboard");
  return { moved: true as const };
}

export async function markOrderCancelled(orderId: string) {
  const user = await requireUser();
  const result = await db.order.updateMany({
    where: { id: orderId, userId: user.id },
    data: { sourcingStatus: "CANCELLED", ebayTrackingSyncError: null },
  });
  if (!result.count) return { error: "Order not found." };
  revalidatePath("/dashboard");
  revalidatePath("/orders");
  return { cancelled: true as const };
}

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
