import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { ebayFeeCents } from "@/lib/fees";
import { deliveryAddressFingerprint } from "@/lib/amazon-email/address-match";
import { ORDER_IMPORT_LOOKBACK_DAYS } from "./import-window";
import { allocateCents, type RemoteOrderFinancials } from "@/lib/ebay/order-financials";

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
): Promise<{ imported: number; financialsSynced: number; financialsWarning: string | null }> {
  const ebay = ebayClient ?? (await getEbayClientForUser(userId));
  const since = new Date(Date.now() - LOOKBACK_MS);
  const remoteOrders = await ebay.getOrders(userId, since);
  if (remoteOrders.length === 0) return { imported: 0, financialsSynced: 0, financialsWarning: null };

  const checkoutIds = [...new Set(remoteOrders.flatMap((order) =>
    order.checkoutOrderId ? [order.checkoutOrderId] : [],
  ))];
  const existingFinancials = checkoutIds.length > 0
    ? await db.order.findMany({
        where: { userId, ebayCheckoutOrderId: { in: checkoutIds } },
        select: {
          ebayCheckoutOrderId: true,
          ebayFinancialsSource: true,
          ebayFinancialsCheckedAt: true,
        },
      })
    : [];
  const financialRowsByCheckout = new Map<string, typeof existingFinancials>();
  for (const row of existingFinancials) {
    if (!row.ebayCheckoutOrderId) continue;
    const rows = financialRowsByCheckout.get(row.ebayCheckoutOrderId) ?? [];
    rows.push(row);
    financialRowsByCheckout.set(row.ebayCheckoutOrderId, rows);
  }
  const actualRefreshCutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const pendingRefreshCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
  const checkoutSaleDates = new Map<string, number>();
  for (const order of remoteOrders) {
    if (!order.checkoutOrderId) continue;
    checkoutSaleDates.set(order.checkoutOrderId, Math.max(
      checkoutSaleDates.get(order.checkoutOrderId) ?? 0,
      order.saleDate.getTime(),
    ));
  }
  const financialCandidates = checkoutIds
    .filter((checkoutId) => {
      const rows = financialRowsByCheckout.get(checkoutId) ?? [];
      return rows.length === 0 || rows.some((row) =>
        !row.ebayFinancialsCheckedAt
        || row.ebayFinancialsCheckedAt < (row.ebayFinancialsSource === "ACTUAL" ? actualRefreshCutoff : pendingRefreshCutoff),
      );
    })
    .sort((a, b) => (checkoutSaleDates.get(b) ?? 0) - (checkoutSaleDates.get(a) ?? 0))
    .slice(0, 50);

  let financials: RemoteOrderFinancials[] = [];
  let financialsWarning: string | null = null;
  let financialLookupCompleted = false;
  if (financialCandidates.length > 0 && ebay.getOrderFinancials) {
    try {
      financials = await ebay.getOrderFinancials(userId, financialCandidates);
      financialLookupCompleted = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "eBay order earnings are temporarily unavailable.";
      financialsWarning = /403|insufficient|scope|authorization/i.test(message)
        ? "Reconnect eBay in Settings once to import actual transaction and advertising fees. Estimates are still being used."
        : `Actual eBay fees could not be refreshed: ${message.slice(0, 180)}`;
    }
  }

  type AllocatedFinancials = Omit<RemoteOrderFinancials, "feeBreakdown"> & {
    feeBreakdownJson: string;
  };
  const allocatedByRemoteOrderId = new Map<string, AllocatedFinancials>();
  for (const financial of financials) {
    const lines = remoteOrders.filter((order) => order.checkoutOrderId === financial.orderId);
    if (lines.length === 0) continue;
    const weights = lines.map((line) => line.salePriceCents * line.quantity + line.shippingChargedCents);
    const components = {
      grossAmountCents: allocateCents(financial.grossAmountCents, weights),
      orderEarningsCents: allocateCents(financial.orderEarningsCents, weights),
      transactionFeeCents: allocateCents(financial.transactionFeeCents, weights),
      advertisingFeeCents: allocateCents(financial.advertisingFeeCents, weights),
      otherFeeCents: allocateCents(financial.otherFeeCents, weights),
      shippingLabelCents: allocateCents(financial.shippingLabelCents, weights),
      refundCents: allocateCents(financial.refundCents, weights),
    };
    const feeAllocations = financial.feeBreakdown.map((fee) => ({
      type: fee.type,
      amounts: allocateCents(fee.amountCents, weights),
    }));
    lines.forEach((line, index) => {
      allocatedByRemoteOrderId.set(line.ebayOrderId, {
        orderId: financial.orderId,
        grossAmountCents: components.grossAmountCents[index],
        orderEarningsCents: components.orderEarningsCents[index],
        transactionFeeCents: components.transactionFeeCents[index],
        advertisingFeeCents: components.advertisingFeeCents[index],
        otherFeeCents: components.otherFeeCents[index],
        shippingLabelCents: components.shippingLabelCents[index],
        refundCents: components.refundCents[index],
        feeBreakdownJson: JSON.stringify(feeAllocations.map((fee) => ({
          type: fee.type,
          amountCents: fee.amounts[index],
        }))),
        updatedAt: financial.updatedAt,
      });
    });
  }

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

    const actualFinancials = allocatedByRemoteOrderId.get(remote.ebayOrderId);
    const financialData = actualFinancials ? {
      ebayCheckoutOrderId: actualFinancials.orderId,
      ebayGrossAmountCents: actualFinancials.grossAmountCents,
      ebayOrderEarningsCents: actualFinancials.orderEarningsCents,
      ebayTransactionFeeCents: actualFinancials.transactionFeeCents,
      ebayAdvertisingFeeCents: actualFinancials.advertisingFeeCents,
      ebayOtherFeeCents: actualFinancials.otherFeeCents,
      ebayShippingLabelCents: actualFinancials.shippingLabelCents,
      ebayRefundCents: actualFinancials.refundCents,
      ebayFeeBreakdownJson: actualFinancials.feeBreakdownJson,
      ebayFinancialsSource: "ACTUAL",
      ebayFinancialsCheckedAt: new Date(),
      ebayFinancialsUpdatedAt: actualFinancials.updatedAt ?? new Date(),
      ebayFinancialsError: null,
      ebayFeeCents: actualFinancials.transactionFeeCents
        + actualFinancials.otherFeeCents
        + actualFinancials.shippingLabelCents,
    } : {
      ...(remote.checkoutOrderId && { ebayCheckoutOrderId: remote.checkoutOrderId }),
      ...(financialLookupCompleted && remote.checkoutOrderId && financialCandidates.includes(remote.checkoutOrderId) && {
        ebayFinancialsCheckedAt: new Date(),
        ebayFinancialsError: null,
      }),
    };

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
            ...financialData,
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
            ebayTrackingNumber: remote.trackingNumber ?? null,
            ebayTrackingCarrier: remote.trackingCarrier ?? null,
            ebayTrackingSyncedAt: remote.trackingNumber ? new Date() : null,
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
            ...financialData,
            ...(remote.status && { status: remote.status }),
            ...(remote.status === "SHIPPED" && { sourcingStatus: "SHIPPED" }),
            ...(remote.trackingNumber && {
              ebayTrackingNumber: remote.trackingNumber,
              ebayTrackingCarrier: remote.trackingCarrier ?? null,
              ebayTrackingSyncedAt: new Date(),
              ebayTrackingSyncError: null,
            }),
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
  return { imported, financialsSynced: financials.length, financialsWarning };
}
