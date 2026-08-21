import "server-only";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { recordListingActivity } from "@/lib/listings/activity-history";
import { publishListingForUser } from "@/lib/listings/publish";
import { getProtectedPriceListings } from "@/lib/listings/winner";
import { isEndedEbayListingError, verifiedProfitProtectionDecision } from "./profit-protection-policy";

export type ProfitProtectionSummary = {
  checked: number;
  awaitingVerification: number;
  winnerLocked: number;
  eligible: number;
  adjusted: number;
  relisted: number;
  protected: number;
  review: number;
  failed: number;
};

export async function protectVerifiedOrderMargins(
  userId: string,
  options: { ebay?: EbayClient; orderIds?: string[]; maxOrders?: number } = {},
): Promise<ProfitProtectionSummary> {
  const summary: ProfitProtectionSummary = {
    checked: 0,
    awaitingVerification: 0,
    winnerLocked: 0,
    eligible: 0,
    adjusted: 0,
    relisted: 0,
    protected: 0,
    review: 0,
    failed: 0,
  };
  const user = await db.user.findUnique({ where: { id: userId }, select: { ebaySitewideDiscountBps: true, ebayAdRateBps: true, targetProfitEnabled: true, targetProfitCents: true } });
  if (!user) return summary;
  const maxVerifiedOrders = options.maxOrders ?? 10;
  const explicitRetry = Boolean(options.orderIds?.length);
  const orders = await db.order.findMany({
    where: {
      userId,
      ...(options.orderIds?.length ? { id: { in: options.orderIds } } : {}),
      status: { not: "REFUNDED" },
      sourcingStatus: { not: "CANCELLED" },
      amazonPurchaseItem: { isNot: null },
      OR: explicitRetry
        ? [{ profitProtectionStatus: null }, { profitProtectionStatus: "FAILED" }]
        : [{ profitProtectionStatus: null }],
    },
    include: { listing: { include: { product: true } }, amazonPurchaseItem: true },
    orderBy: { saleDate: "desc" },
    // Orders whose Amazon emails do not expose a final price are skipped.
    // Scan beyond the verified-work limit so those rows cannot permanently
    // starve older orders whose landed costs are ready for protection.
    take: explicitRetry
      ? Math.max(1, options.orderIds?.length ?? 1)
      : Math.max(100, maxVerifiedOrders * 10),
  });
  if (!orders.length) return summary;
  const winnerListings = explicitRetry
    ? new Map()
    : await getProtectedPriceListings(userId, user.ebayAdRateBps);

  let ebay = options.ebay;
  const latestPriceByListing = new Map<string, number>();
  const latestEbayIdByListing = new Map<string, string>();
  for (const order of orders) {
    if (!order.amazonPurchaseItem) continue;
    const verifiedCostCents = actualAmazonCost(order.amazonPurchaseItem);
    if (verifiedCostCents === null) {
      summary.awaitingVerification++;
      continue;
    }
    if (winnerListings.has(order.listingId)) {
      summary.winnerLocked++;
      continue;
    }
    if (summary.checked >= maxVerifiedOrders) break;
    summary.checked++;
    const currentPriceCents = latestPriceByListing.get(order.listingId) ?? order.listing.priceCents;
    const decision = verifiedProfitProtectionDecision({
      currentListingPriceCents: currentPriceCents,
      orderQuantity: order.quantity,
      realizedRevenueCents: order.salePriceCents * order.quantity + order.shippingChargedCents,
      realizedEbayFeeCents: order.ebayFeeCents,
      verifiedAmazonCostCents: verifiedCostCents,
      sitewideDiscountBps: user.ebaySitewideDiscountBps,
      adRateBps: user.ebayAdRateBps,
      targetProfitCents: user.targetProfitEnabled ? user.targetProfitCents : null,
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
