import "server-only";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import type { EbayClient } from "@/lib/ebay/client";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { recordListingActivity } from "@/lib/listings/activity-history";
import { publishListingForUser } from "@/lib/listings/publish";
import { getProtectedPriceListings } from "@/lib/listings/winner";
import { isEndedEbayListingError, VERIFIED_MARGIN_TARGET_BPS, VERIFIED_PROFIT_TARGET_CENTS, verifiedProfitProtectionDecision } from "./profit-protection-policy";
import { discountedEbayPriceCents, grossUpEbayPriceCents } from "@/lib/fees";
import { listingPricePlan, MAX_BUYER_SHIPPING_CENTS, MIN_BUYER_SHIPPING_CENTS, normalizePricingStrategy, trueProfitWithBuyerShippingCents } from "@/lib/listings/shipping-strategy";
import { isEbayPicturePolicyError, prepareEbayImages } from "@/lib/ebay/image-policy";
import { parseImageUrls, serializeImageUrls } from "@/lib/types";
import { orderProfitBreakdown } from "./profit";
import { applyShippingStrategyToDescription, applyShippingStrategyToTitle } from "@/lib/ebay/description";
import { resolveTargetProfitCents } from "@/lib/listings/target-profit";

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
  deferred: number;
};

export async function protectVerifiedOrderMargins(
  userId: string,
  options: { ebay?: EbayClient; orderIds?: string[]; maxOrders?: number; retryFailures?: boolean; maxRuntimeMs?: number } = {},
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
    deferred: 0,
  };
  const deadline = options.maxRuntimeMs ? Date.now() + Math.max(1_000, options.maxRuntimeMs) : null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { ebaySitewideDiscountBps: true, ebayAdRateBps: true, targetProfitEnabled: true, targetProfitMode: true, targetProfitMinCents: true, targetProfitCents: true, pricingStrategy: true } });
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
      OR: explicitRetry || options.retryFailures
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

  // Several historical orders can point to the same eBay listing. Evaluate
  // all verified costs first and keep only the order that requires the
  // highest future price. One successful eBay update then covers every lower
  // target for that listing.
  const representativeOrderIds = new Set(orders.map((order) => order.id));
  const coveredOrderIdsByRepresentative = new Map<string, string[]>();
  const ordersByListing = new Map<string, typeof orders>();
  for (const order of orders) {
    const group = ordersByListing.get(order.listingId) ?? [];
    group.push(order);
    ordersByListing.set(order.listingId, group);
  }
  for (const listingOrders of ordersByListing.values()) {
    const repricingCandidates: Array<{ orderId: string; targetPriceCents: number }> = [];
    const verifiedOrderIds: string[] = [];
    for (const order of listingOrders) {
      if (!order.amazonPurchaseItem) continue;
      const verifiedCostCents = actualAmazonCost(order.amazonPurchaseItem);
      if (verifiedCostCents === null) continue;
      verifiedOrderIds.push(order.id);
      const realized = orderProfitBreakdown({ ...order, actualAmazonCostCents: verifiedCostCents }, user.ebayAdRateBps);
      const decision = verifiedProfitProtectionDecision({
        currentListingPriceCents: order.listing.priceCents,
        orderQuantity: order.quantity,
        realizedRevenueCents: realized.revenueCents,
        realizedEbayFeeCents: realized.transactionFeeCents + realized.otherEbayCostCents + realized.shippingLabelCents + realized.refundCents,
        realizedAdvertisingFeeCents: realized.advertisingFeeCents,
        verifiedAmazonCostCents: verifiedCostCents,
        sitewideDiscountBps: user.ebaySitewideDiscountBps,
        adRateBps: user.ebayAdRateBps,
        targetProfitCents: resolveTargetProfitCents(user, {
          amazonCostCents: Math.ceil(verifiedCostCents / Math.max(1, order.quantity)),
          currentEbayPriceCents: order.listing.priceCents,
        }),
      });
      if (decision.action === "reprice") {
        repricingCandidates.push({ orderId: order.id, targetPriceCents: decision.targetPriceCents });
      }
    }
    if (repricingCandidates.length <= 1) continue;
    const representative = repricingCandidates.reduce((highest, candidate) =>
      candidate.targetPriceCents > highest.targetPriceCents ? candidate : highest,
    );
    const coveredIds = verifiedOrderIds.filter((orderId) => orderId !== representative.orderId);
    for (const orderId of coveredIds) representativeOrderIds.delete(orderId);
    coveredOrderIdsByRepresentative.set(representative.orderId, coveredIds);
  }

  let ebay = options.ebay;
  const latestPriceByListing = new Map<string, number>();
  const latestEbayIdByListing = new Map<string, string>();
  const clearCoveredSiblingFailures = (listingId: string, currentOrderId: string, protectedPriceCents: number) => {
    const coveredOrderIds = coveredOrderIdsByRepresentative.get(currentOrderId) ?? [];
    return db.order.updateMany({
    where: {
      userId,
      listingId,
      id: { not: currentOrderId },
      status: { not: "REFUNDED" },
      sourcingStatus: { not: "CANCELLED" },
      OR: [
        ...(coveredOrderIds.length ? [{ id: { in: coveredOrderIds } }] : []),
        {
          profitProtectionStatus: { in: ["FAILED", "REVIEW_REQUIRED"] },
          profitProtectionNewPriceCents: { lte: protectedPriceCents },
        },
      ],
    },
    data: {
      profitProtectionStatus: "ALREADY_PROTECTED",
      profitProtectionReviewedAt: new Date(),
      profitProtectionNewPriceCents: protectedPriceCents,
      profitProtectionError: null,
    },
    });
  };
  for (const [orderIndex, order] of orders.entries()) {
    if (deadline !== null && Date.now() >= deadline) {
      summary.deferred = orders.slice(orderIndex).filter((candidate) => representativeOrderIds.has(candidate.id)).length;
      break;
    }
    if (!representativeOrderIds.has(order.id)) continue;
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
    const realized = orderProfitBreakdown({ ...order, actualAmazonCostCents: verifiedCostCents }, user.ebayAdRateBps);
    const decision = verifiedProfitProtectionDecision({
      currentListingPriceCents: currentPriceCents,
      orderQuantity: order.quantity,
      realizedRevenueCents: realized.revenueCents,
      realizedEbayFeeCents: realized.transactionFeeCents + realized.otherEbayCostCents + realized.shippingLabelCents + realized.refundCents,
      realizedAdvertisingFeeCents: realized.advertisingFeeCents,
      verifiedAmazonCostCents: verifiedCostCents,
      sitewideDiscountBps: user.ebaySitewideDiscountBps,
      adRateBps: user.ebayAdRateBps,
      targetProfitCents: resolveTargetProfitCents(user, {
        amazonCostCents: Math.ceil(verifiedCostCents / Math.max(1, order.quantity)),
        currentEbayPriceCents: currentPriceCents,
      }),
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
      await db.$transaction([
        db.order.update({ where: { id: order.id }, data: {
          profitProtectionStatus: "ALREADY_PROTECTED",
          profitProtectionReviewedAt: new Date(),
          profitProtectionOldPriceCents: currentPriceCents,
          profitProtectionNewPriceCents: currentPriceCents,
          profitProtectionError: null,
        } }),
        clearCoveredSiblingFailures(order.listingId, order.id, currentPriceCents),
      ]);
      summary.protected++;
      continue;
    }

    const strategy = normalizePricingStrategy(user.pricingStrategy);
    const requiredBuyerRevenueCents = discountedEbayPriceCents(decision.targetPriceCents, user.ebaySitewideDiscountBps);
    let protectedPriceCents = decision.targetPriceCents;
    let protectedBuyerShippingCents = 0;
    if (strategy === "BUYER_PAID_SHIPPING") {
      protectedBuyerShippingCents = Math.min(MAX_BUYER_SHIPPING_CENTS, Math.max(0, requiredBuyerRevenueCents - discountedEbayPriceCents(99, user.ebaySitewideDiscountBps)));
      protectedPriceCents = Math.max(99, grossUpEbayPriceCents(requiredBuyerRevenueCents - protectedBuyerShippingCents, user.ebaySitewideDiscountBps));
    } else if (strategy === "AI" && currentPriceCents < decision.targetPriceCents) {
      const neededAtCurrent = requiredBuyerRevenueCents - discountedEbayPriceCents(currentPriceCents, user.ebaySitewideDiscountBps);
      protectedBuyerShippingCents = Math.min(MAX_BUYER_SHIPPING_CENTS, Math.max(0, neededAtCurrent));
      if (neededAtCurrent > MAX_BUYER_SHIPPING_CENTS) {
        protectedPriceCents = Math.max(99, grossUpEbayPriceCents(requiredBuyerRevenueCents - MAX_BUYER_SHIPPING_CENTS, user.ebaySitewideDiscountBps));
      } else {
        protectedPriceCents = currentPriceCents;
      }
    }
    if (protectedBuyerShippingCents > 0 && protectedBuyerShippingCents < MIN_BUYER_SHIPPING_CENTS) {
      protectedBuyerShippingCents = 0;
      const unitCostCents = Math.ceil(verifiedCostCents / Math.max(1, order.quantity));
      const minimumProfitCents = user.targetProfitEnabled
        ? user.targetProfitMode === "AI_RANGE"
          ? Math.max(0, user.targetProfitMinCents)
          : Math.max(0, user.targetProfitCents)
        : Math.min(
            VERIFIED_PROFIT_TARGET_CENTS,
            Math.ceil(discountedEbayPriceCents(currentPriceCents, user.ebaySitewideDiscountBps) * VERIFIED_MARGIN_TARGET_BPS / 10_000),
          );
      const currentFreeProfitCents = trueProfitWithBuyerShippingCents(currentPriceCents, 0, unitCostCents, 0, user.ebaySitewideDiscountBps, user.ebayAdRateBps);
      protectedPriceCents = currentFreeProfitCents >= minimumProfitCents
        ? currentPriceCents
        : listingPricePlan({
            amazonCostCents: unitCostCents,
            amazonShippingCents: 0,
            currentEbayPriceCents: currentPriceCents,
            sitewideDiscountBps: user.ebaySitewideDiscountBps,
            adRateBps: user.ebayAdRateBps,
            targetProfitCents: minimumProfitCents,
            pricingStrategy: "FREE_SHIPPING",
          }).itemPriceCents;
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
            listingPriceCents: protectedPriceCents,
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
          priceCents: protectedPriceCents,
          buyerShippingCents: protectedBuyerShippingCents,
          shippingStrategy: protectedBuyerShippingCents > 0 ? "BUYER_PAID_SHIPPING" : "FREE_SHIPPING",
          quantity: Math.max(1, order.listing.quantity),
        },
      });
      const published = await publishListingForUser(userId, order.listingId, {
        recoverEndedReasons: ["MANUAL"],
      });
      if (!published.ok) return published.error;
      await db.$transaction([
        db.order.update({ where: { id: order.id }, data: {
          profitProtectionStatus: "RELISTED",
          profitProtectionReviewedAt: new Date(),
          profitProtectionOldPriceCents: currentPriceCents,
          profitProtectionNewPriceCents: protectedPriceCents,
          profitProtectionError: null,
        } }),
        clearCoveredSiblingFailures(order.listingId, order.id, protectedPriceCents),
      ]);
      latestPriceByListing.set(order.listingId, protectedPriceCents);
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
          profitProtectionNewPriceCents: protectedPriceCents,
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
        profitProtectionNewPriceCents: protectedPriceCents,
        profitProtectionError: "The listing is not active on eBay.",
      } });
      summary.review++;
      continue;
    }

    try {
      ebay ??= await getEbayClientForUser(userId);
      let repairedImageUrls: string[] | undefined;
      const strategyDescription = applyShippingStrategyToDescription(order.listing.description, protectedBuyerShippingCents);
      const strategyTitle = applyShippingStrategyToTitle(order.listing.title, protectedBuyerShippingCents);
      try {
        await ebay.updateListing(currentEbayListingId, { priceCents: protectedPriceCents, buyerShippingCents: protectedBuyerShippingCents, description: strategyDescription, title: strategyTitle });
      } catch (updateError) {
        const updateMessage = updateError instanceof Error ? updateError.message : "eBay price update failed";
        if (!isEbayPicturePolicyError(updateMessage)) throw updateError;
        const prepared = await prepareEbayImages(userId, parseImageUrls(order.listing.imageUrlsJson));
        if (prepared.imageUrls.length === 0) {
          throw new Error("The listing image does not meet eBay's 500-pixel requirement and no compliant replacement could be prepared.");
        }
        repairedImageUrls = prepared.imageUrls;
        await ebay.updateListing(currentEbayListingId, {
          priceCents: protectedPriceCents,
          buyerShippingCents: protectedBuyerShippingCents,
          description: strategyDescription,
          title: strategyTitle,
          imageUrls: repairedImageUrls,
        });
      }
      await db.$transaction([
        db.listing.update({ where: { id: order.listingId }, data: { priceCents: protectedPriceCents, buyerShippingCents: protectedBuyerShippingCents, shippingStrategy: protectedBuyerShippingCents > 0 ? "BUYER_PAID_SHIPPING" : "FREE_SHIPPING", description: strategyDescription, title: strategyTitle, ...(repairedImageUrls && { imageUrlsJson: serializeImageUrls(repairedImageUrls) }) } }),
        db.order.update({ where: { id: order.id }, data: {
          profitProtectionStatus: "ADJUSTED",
          profitProtectionReviewedAt: new Date(),
          profitProtectionOldPriceCents: currentPriceCents,
          profitProtectionNewPriceCents: protectedPriceCents,
          profitProtectionError: null,
        } }),
        clearCoveredSiblingFailures(order.listingId, order.id, protectedPriceCents),
      ]);
      latestPriceByListing.set(order.listingId, protectedPriceCents);
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
        profitProtectionNewPriceCents: protectedPriceCents,
        profitProtectionError: message,
      } });
      summary.failed++;
    }
  }
  return summary;
}
