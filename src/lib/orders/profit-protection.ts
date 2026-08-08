import "server-only";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { recordListingActivity } from "@/lib/listings/activity-history";
import { publishListingForUser } from "@/lib/listings/publish";
import { isEndedEbayListingError, verifiedProfitProtectionDecision } from "./profit-protection-policy";

export type ProfitProtectionSummary = { eligible: number; adjusted: number; relisted: number; protected: number; review: number; failed: number };

export async function protectVerifiedOrderMargins(
  userId: string,
  options: { ebay?: EbayClient; orderIds?: string[]; maxOrders?: number } = {},
): Promise<ProfitProtectionSummary> {
  const summary: ProfitProtectionSummary = { eligible: 0, adjusted: 0, relisted: 0, protected: 0, review: 0, failed: 0 };
  const orders = await db.order.findMany({
    where: {
      userId,
      ...(options.orderIds?.length ? { id: { in: options.orderIds } } : {}),
      status: { not: "REFUNDED" },
      sourcingStatus: { not: "CANCELLED" },
      amazonPurchaseItem: { isNot: null },
      OR: [{ profitProtectionStatus: null }, { profitProtectionStatus: "FAILED" }],
    },
    include: { listing: { include: { product: true } }, amazonPurchaseItem: true },
    orderBy: { saleDate: "desc" },
    take: options.maxOrders ?? 10,
  });
  if (!orders.length) return summary;

  let ebay = options.ebay;
  const latestPriceByListing = new Map<string, number>();
  const latestEbayIdByListing = new Map<string, string>();
  for (const order of orders) {
    if (!order.amazonPurchaseItem) continue;
    const verifiedCostCents = actualAmazonCost(order.amazonPurchaseItem);
    if (verifiedCostCents === null) continue;
    const currentPriceCents = latestPriceByListing.get(order.listingId) ?? order.listing.priceCents;
    const decision = verifiedProfitProtectionDecision({
      currentListingPriceCents: currentPriceCents,
      orderQuantity: order.quantity,
      realizedRevenueCents: order.salePriceCents * order.quantity + order.shippingChargedCents,
      realizedEbayFeeCents: order.ebayFeeCents,
      verifiedAmazonCostCents: verifiedCostCents,
    });
    if (decision.action === "not_required") {
      await db.order.update({ where: { id: order.id }, data: {
        profitProtectionStatus: "NOT_REQUIRED",
        profitProtectionReviewedAt: new Date(),
        profitProtectionOldPriceCents: currentPriceCents,
        profitProtectionNewPriceCents: currentPriceCents,
        profitProtectionError: null,
      } });
      continue;
    }
    summary.eligible++;

    if (decision.action === "already_protected") {
      await db.order.update({ where: { id: order.id }, data: {
        profitProtectionStatus: "ALREADY_PROTECTED",
        profitProtectionReviewedAt: new Date(),
        profitProtectionOldPriceCents: currentPriceCents,
        profitProtectionNewPriceCents: currentPriceCents,
        profitProtectionError: null,
      } });
      summary.protected++;
      continue;
    }

    const recordSuccess = async (ebayListingId: string) => {
      try {
        await recordListingActivity({
          userId,
          source: "PROFIT_PROTECTION",
          trigger: "AUTOMATIC",
          items: [{
            title: order.listing.title,
            listingId: order.listingId,
            ebayListingId,
            amazonUrl: order.listing.product.supplierUrl,
            sourcePriceCents: verifiedCostCents,
            listingPriceCents: decision.targetPriceCents,
            ok: true,
          }],
        });
      } catch (activityError) {
        console.error("Could not record profit-protection activity", activityError);
      }
    };

    const relistAtProtectedPrice = async (): Promise<string | null> => {
      await db.listing.update({
        where: { id: order.listingId },
        data: {
          status: "ENDED",
          endedAt: new Date(),
          endedReason: "MANUAL",
          priceCents: decision.targetPriceCents,
          quantity: Math.max(1, order.listing.quantity),
        },
      });
      const published = await publishListingForUser(userId, order.listingId, {
        recoverEndedReasons: ["MANUAL"],
      });
      if (!published.ok) return published.error;
      await db.order.update({ where: { id: order.id }, data: {
        profitProtectionStatus: "RELISTED",
        profitProtectionReviewedAt: new Date(),
        profitProtectionOldPriceCents: currentPriceCents,
        profitProtectionNewPriceCents: decision.targetPriceCents,
        profitProtectionError: null,
      } });
      latestPriceByListing.set(order.listingId, decision.targetPriceCents);
      latestEbayIdByListing.set(order.listingId, published.ebayListingId);
      await recordSuccess(published.ebayListingId);
      summary.adjusted++;
      summary.relisted++;
      return null;
    };

    if (order.listing.status === "ENDED") {
      try {
        const relistError = await relistAtProtectedPrice();
        if (!relistError) continue;
        throw new Error(relistError);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "eBay relisting failed";
        await db.order.update({ where: { id: order.id }, data: {
          profitProtectionStatus: "FAILED",
          profitProtectionReviewedAt: new Date(),
          profitProtectionOldPriceCents: currentPriceCents,
          profitProtectionNewPriceCents: decision.targetPriceCents,
          profitProtectionError: message,
        } });
        summary.failed++;
        continue;
      }
    }

    const currentEbayListingId = latestEbayIdByListing.get(order.listingId) ?? order.listing.ebayListingId;
    if (order.listing.status !== "ACTIVE" || !currentEbayListingId) {
      await db.order.update({ where: { id: order.id }, data: {
        profitProtectionStatus: "REVIEW_REQUIRED",
        profitProtectionReviewedAt: new Date(),
        profitProtectionOldPriceCents: currentPriceCents,
        profitProtectionNewPriceCents: decision.targetPriceCents,
        profitProtectionError: "The listing is not active on eBay.",
      } });
      summary.review++;
      continue;
    }

    try {
      ebay ??= await getEbayClientForUser(userId);
      await ebay.updateListing(currentEbayListingId, { priceCents: decision.targetPriceCents });
      await db.$transaction([
        db.listing.update({ where: { id: order.listingId }, data: { priceCents: decision.targetPriceCents } }),
        db.order.update({ where: { id: order.id }, data: {
          profitProtectionStatus: "ADJUSTED",
          profitProtectionReviewedAt: new Date(),
          profitProtectionOldPriceCents: currentPriceCents,
          profitProtectionNewPriceCents: decision.targetPriceCents,
          profitProtectionError: null,
        } }),
      ]);
      latestPriceByListing.set(order.listingId, decision.targetPriceCents);
      await recordSuccess(currentEbayListingId);
      summary.adjusted++;
    } catch (error) {
      let message = error instanceof Error ? error.message.slice(0, 500) : "eBay price update failed";
      if (isEndedEbayListingError(message)) {
        try {
          const relistError = await relistAtProtectedPrice();
          if (!relistError) continue;
          message = `The ended listing could not be relisted: ${relistError}`.slice(0, 500);
        } catch (relistError) {
          message = `The ended listing could not be relisted: ${relistError instanceof Error ? relistError.message : "eBay relisting failed"}`.slice(0, 500);
        }
      }
      await db.order.update({ where: { id: order.id }, data: {
        profitProtectionStatus: "FAILED",
        profitProtectionReviewedAt: new Date(),
        profitProtectionOldPriceCents: currentPriceCents,
        profitProtectionNewPriceCents: decision.targetPriceCents,
        profitProtectionError: message,
      } });
      summary.failed++;
    }
  }
  return summary;
}
