"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError, type ListingUpdate } from "@/lib/ebay/client";
import { isAlreadyEndedEbayError } from "@/lib/ebay/errors";
import { isEbayPicturePolicyError, prepareEbayImages } from "@/lib/ebay/image-policy";
import { researchEbayMarket } from "@/lib/ebay/market";
import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";
import {
  createListingsWorkbook,
  type ListingsExcelRow,
} from "@/lib/export/excel";
import {
  matchAndTrackListing,
  untrackListing,
  type TrackInput,
  type TrackResult,
} from "@/lib/mirror/track";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";
import { discountedEbayPriceCents } from "@/lib/fees";
import {
  assessProductMatch,
  assessProductMatchRules,
  isApprovedProductMatch,
} from "@/lib/arbitrage/product-match";
import { findAmazonMatches } from "@/lib/mirror/match";
import { resolveExactAmazonVariant } from "@/lib/mirror/variant";
import { parseImageUrls, serializeImageUrls } from "@/lib/types";
import { publishListingForUser } from "@/lib/listings/publish";
import { getProtectedPriceListings } from "@/lib/listings/winner";
import { isSuggestedPriceCandidate } from "@/lib/listings/suggested-price-candidate";
import { listingPricePlan } from "@/lib/listings/shipping-strategy";
import { improveMainListingImage } from "@/lib/mirror/improve-main-image";
import { improveListingContent } from "@/lib/mirror/improve-listing-content";
import { generateMirrorDescription } from "@/lib/mirror/seo";
import { recordListingActivity } from "@/lib/listings/activity-history";
import { SMART_SYNC_RECOVERABLE_END_REASONS, shouldEndUnavailableSourceListing } from "@/lib/listings/smart-sync-policy";
import { hasSelectedSmartSyncOption, type SmartSyncOptions } from "@/lib/listings/smart-sync-options";
import { getAdminAmazonSourceWithFallback, NoUsableAmazonSourceError } from "@/lib/listings/admin-amazon-source";

export type EbayListingResult = { error?: string };

export async function exportEbayListings(rows: ListingsExcelRow[]) {
  await requireUser();
  return createListingsWorkbook(rows.slice(0, 2000));
}

function revalidate() {
  revalidatePath("/listings");
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
}

/**
 * Find and store the Amazon counterpart of a live eBay listing, so it gets
 * margin tracking and inventory sync like app-created listings. With real
 * data configured this costs one Rainforest credit.
 */
export async function matchEbayListing(input: TrackInput): Promise<TrackResult> {
  const user = await requireUser();
  const result = await matchAndTrackListing(user.id, input);
  revalidate();
  return result;
}

/** How many listings one batch call processes (stays well under the
 * serverless time limit; the client loops batches for Match-all). */
const MATCH_BATCH_SIZE = 10;
const MATCH_CONCURRENCY = 5;

export type MarketResearchResult = {
  ebayListingId: string;
  market: ListingMarketMetrics | null;
  error?: string;
};

/** Research live eBay competitors in small batches; the client loops over
 * larger sets and cached results are reused on future page loads. */
export async function researchEbayListingsMarket(
  items: { ebayListingId: string; title: string }[],
): Promise<MarketResearchResult[]> {
  const user = await requireUser();
  const batch = items.slice(0, 10);
  const results: MarketResearchResult[] = [];
  // Sequential within each small batch avoids racing multiple client-token
  // requests on a cold serverless instance and stays below eBay burst limits.
  for (const item of batch) {
    try {
      const result = await researchEbayMarket(item.title, item.ebayListingId);
      if (!result) {
        await db.ebayMarketMetric.deleteMany({
          where: { userId: user.id, ebayListingId: item.ebayListingId },
        });
        results.push({ ebayListingId: item.ebayListingId, market: null });
        continue;
      }
      await db.ebayMarketMetric.upsert({
        where: {
          userId_ebayListingId: {
            userId: user.id,
            ebayListingId: item.ebayListingId,
          },
        },
        create: {
          userId: user.id,
          ebayListingId: item.ebayListingId,
          query: result.query,
          ...result.metrics,
        },
        update: { query: result.query, ...result.metrics },
      });
      results.push({ ebayListingId: item.ebayListingId, market: result.metrics });
    } catch (error) {
      results.push({
        ebayListingId: item.ebayListingId,
        market: null,
        error: error instanceof Error ? error.message.slice(0, 120) : "Research failed",
      });
    }
  }
  return results;
}

/** Match a batch of listings; the client drives successive batches. */
export async function matchEbayListingsBatch(
  items: TrackInput[],
): Promise<TrackResult[]> {
  const user = await requireUser();
  const batch = items.slice(0, MATCH_BATCH_SIZE);
  const results: TrackResult[] = [];
  for (let i = 0; i < batch.length; i += MATCH_CONCURRENCY) {
    const slice = batch.slice(i, i + MATCH_CONCURRENCY);
    results.push(
      ...(await Promise.all(slice.map((item) => matchAndTrackListing(user.id, item)))),
    );
  }
  revalidate();
  return results;
}

/** Undo a (mis)match: stop tracking the listing on the app side. */
export async function unmatchEbayListing(
  ebayListingId: string,
): Promise<EbayListingResult> {
  const user = await requireUser();
  const result = await untrackListing(user.id, ebayListingId);
  revalidate();
  return result;
}

/** Revise the price of a live eBay listing (any origin). */
export async function repriceEbayListing(
  ebayListingId: string,
  priceCents: number,
  confirmVerifiedWinner = false,
): Promise<EbayListingResult> {
  const user = await requireUser();
  if (priceCents < 99) return { error: "Price must be at least $0.99" };
  const listing = await db.listing.findFirst({
    where: { userId: user.id, ebayListingId },
    include: { product: true },
  });
  if (listing && priceCents !== listing.priceCents) {
    const winnerListings = await getProtectedPriceListings(user.id, user.ebayAdRateBps);
    if (winnerListings.has(listing.id) && !confirmVerifiedWinner) {
      return { error: "This profitable listing's price is locked. Confirm the price-lock warning before changing it." };
    }
  }

  const client = await getEbayClientForUser(user.id);
  try {
    await client.updateListing(ebayListingId, { priceCents });
  } catch (e) {
    if (e instanceof EbayApiError) {
      await recordListingActivity({
        userId: user.id,
        source: "LISTING_EDIT",
        items: [{
          title: listing?.title ?? `eBay listing ${ebayListingId}`,
          listingId: listing?.id,
          ebayListingId,
          amazonUrl: listing?.product.supplierUrl,
          sourcePriceCents: listing?.product.costCents,
          listingPriceCents: priceCents,
          ok: false,
          error: e.message,
        }],
      });
      return { error: e.message };
    }
    throw e;
  }
  await db.listing.updateMany({
    where: { userId: user.id, ebayListingId },
    data: { priceCents },
  });
  await recordListingActivity({
    userId: user.id,
    source: "LISTING_EDIT",
    items: [{
      title: listing?.title ?? `eBay listing ${ebayListingId}`,
      listingId: listing?.id,
      ebayListingId,
      amazonUrl: listing?.product.supplierUrl,
      sourcePriceCents: listing?.product.costCents,
      listingPriceCents: priceCents,
      ok: true,
    }],
  });
  revalidate();
  return {};
}

export type TargetProfitPriceResult = {
  ebayListingId: string;
  ok: boolean;
  newPriceCents?: number;
  modeledProfitCents?: number;
  amazonPriceCents?: number;
  amazonShippingCents?: number;
  buyerShippingCents?: number;
  shippingStrategy?: string;
  error?: string;
};

/** Set one seller listing to the minimum price that reaches a requested net
 * profit. Existing ASINs reuse the administrator catalog; the first missing
 * ASIN is fetched once and promoted into that shared catalog. */
export async function applyTargetProfitPrice(
  ebayListingId: string,
  targetProfitCents: number,
  confirmVerifiedWinner = false,
): Promise<TargetProfitPriceResult> {
  const user = await requireUser();
  const target = Math.round(targetProfitCents);
  const fail = (error: string): TargetProfitPriceResult => ({
    ebayListingId,
    ok: false,
    error,
  });
  if (!Number.isFinite(target) || target < 0 || target > 1_000_000) {
    return fail("Target profit must be between $0 and $10,000 per item.");
  }

  const listing = await db.listing.findFirst({
    where: { userId: user.id, ebayListingId, status: "ACTIVE" },
    include: { product: true },
  });
  if (!listing) return fail("The listing is no longer tracked and active.");

  const winners = await getProtectedPriceListings(user.id, user.ebayAdRateBps);
  if (winners.has(listing.id) && !confirmVerifiedWinner) {
    return fail("This profitable listing's price is locked. Confirm the price-lock warning before changing it.");
  }

  const asin = listing.product.supplierProductId.trim().toUpperCase();
  let adminSource: Awaited<ReturnType<typeof getAdminAmazonSourceWithFallback>>;
  try {
    adminSource = await getAdminAmazonSourceWithFallback(asin);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Amazon product data could not be retrieved.");
  }
  if (!adminSource.amazonInStock) {
    return fail("The admin catalog currently marks this Amazon product out of stock.");
  }

  const plan = listingPricePlan({ amazonCostCents: adminSource.amazonPriceCents, amazonShippingCents: adminSource.amazonShippingCents, currentEbayPriceCents: listing.priceCents, ebayRecommendedPriceCents: adminSource.ebayRecommendedPriceCents, averageCompetitorPriceCents: adminSource.averageCompetitorPriceCents, sitewideDiscountBps: user.ebaySitewideDiscountBps, adRateBps: user.ebayAdRateBps, targetProfitCents: target, pricingStrategy: user.pricingStrategy });
  const newPriceCents = plan.itemPriceCents;
  const modeledProfitCents = plan.modeledProfitCents;

  const client = await getEbayClientForUser(user.id);
  try {
    if (newPriceCents !== listing.priceCents || plan.buyerShippingCents !== listing.buyerShippingCents) {
      await client.updateListing(ebayListingId, { priceCents: newPriceCents, buyerShippingCents: plan.buyerShippingCents });
    }
  } catch (error) {
    return fail(
      error instanceof EbayApiError
        ? error.message.slice(0, 180)
        : error instanceof Error
          ? error.message.slice(0, 180)
          : "eBay rejected the target-profit price update.",
    );
  }

  await db.$transaction([
    db.product.update({
      where: { id: listing.product.id },
      data: {
        supplierProductId: adminSource.asin,
        supplierUrl: adminSource.amazonUrl,
        costCents: adminSource.amazonPriceCents,
        shippingCostCents: adminSource.amazonShippingCents,
        supplierStock: 50,
      },
    }),
    db.listing.update({
      where: { id: listing.id },
      data: { priceCents: newPriceCents, buyerShippingCents: plan.buyerShippingCents, shippingStrategy: plan.shippingStrategy },
    }),
  ]);
  await recordListingActivity({
    userId: user.id,
    source: "LISTING_EDIT",
    items: [{
      title: listing.title,
      listingId: listing.id,
      ebayListingId,
      amazonUrl: adminSource.amazonUrl,
      sourcePriceCents: adminSource.amazonPriceCents + adminSource.amazonShippingCents,
      listingPriceCents: newPriceCents,
      ok: true,
    }],
  });
  revalidate();
  return {
    ebayListingId,
    ok: true,
    newPriceCents,
    modeledProfitCents,
    amazonPriceCents: adminSource.amazonPriceCents,
    amazonShippingCents: adminSource.amazonShippingCents,
    buyerShippingCents: plan.buyerShippingCents,
    shippingStrategy: plan.shippingStrategy,
  };
}

export type EnhanceListingResult = {
  ebayListingId: string;
  ok: boolean;
  title?: string;
  imageUrl?: string | null;
  contentEnhanced?: boolean;
  imageEnhanced?: boolean;
  imageWarning?: string;
  contentWarning?: string;
  warning?: string;
  error?: string;
};

function sourceBullets(description: string): string[] {
  return description
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((part) => part.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 12)
    .slice(0, 8);
}

/** Enhance one tracked live listing. The browser calls this once per selected
 * row so long-running image edits have durable per-item progress. */
export async function enhanceEbayListing(
  ebayListingId: string,
): Promise<EnhanceListingResult> {
  const user = await requireUser();
  if (!user.improveMainImage && !user.improveListingContent) {
    return {
      ebayListingId,
      ok: false,
      error: "Enable AI image enhancement and/or AI title & description optimization in Settings first.",
    };
  }
  const listing = await db.listing.findFirst({
    where: { userId: user.id, ebayListingId, status: "ACTIVE" },
    include: { product: true },
  });
  if (!listing) {
    return {
      ebayListingId,
      ok: false,
      error: "This eBay listing does not have a tracked Amazon source in Sellfinity.",
    };
  }

  const sourceImages = parseImageUrls(listing.product.imageUrlsJson);
  const source = {
    title: listing.product.title,
    brand: "",
    bulletPoints: sourceBullets(listing.product.description),
    description: listing.product.description,
    category: listing.product.category,
    imageUrls: sourceImages,
  };
  const [copyResult, imageResult] = await Promise.all([
    user.improveListingContent
      ? improveListingContent(source)
      : Promise.resolve(null),
    user.improveMainImage
      ? improveMainListingImage({
          userId: user.id,
          sourceImageUrl: sourceImages[0],
          title: source.title,
          category: source.category,
          bulletPoints: source.bulletPoints,
        })
      : Promise.resolve(null),
  ]);

  const improvedSource = copyResult?.ok
    ? { ...source, ...copyResult.content }
    : source;
  const title = copyResult?.ok ? copyResult.content.title : undefined;
  const description = copyResult?.ok
    ? generateMirrorDescription(improvedSource)
    : undefined;
  const imageUrls = imageResult?.ok
    ? [imageResult.imageUrl, ...sourceImages].slice(0, 12)
    : undefined;
  if (!title && !imageUrls) {
    const error =
      (!copyResult?.ok && copyResult?.error) ||
      (!imageResult?.ok && imageResult?.error) ||
      "AI enhancement did not produce an update.";
    await recordListingActivity({
      userId: user.id,
      source: "AI_OPTIMIZATION",
      improveMainImage: user.improveMainImage,
      improveListingContent: user.improveListingContent,
      items: [{
        title: listing.title,
        listingId: listing.id,
        ebayListingId,
        amazonUrl: listing.product.supplierUrl,
        sourcePriceCents: listing.product.costCents,
        listingPriceCents: listing.priceCents,
        ok: false,
        error,
        imageError: imageResult && !imageResult.ok ? imageResult.error : null,
      }],
    });
    return {
      ebayListingId,
      ok: false,
      error,
    };
  }

  try {
    const client = await getEbayClientForUser(user.id);
    await client.updateListing(ebayListingId, { title, description, imageUrls });
    await db.listing.update({
      where: { id: listing.id },
      data: {
        ...(title && { title }),
        ...(description && { description }),
        ...(imageUrls && { imageUrlsJson: serializeImageUrls(imageUrls) }),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "eBay update failed.";
    await recordListingActivity({
      userId: user.id,
      source: "AI_OPTIMIZATION",
      improveMainImage: user.improveMainImage,
      improveListingContent: user.improveListingContent,
      items: [{
        title: title ?? listing.title,
        listingId: listing.id,
        ebayListingId,
        amazonUrl: listing.product.supplierUrl,
        sourcePriceCents: listing.product.costCents,
        listingPriceCents: listing.priceCents,
        ok: false,
        error: message,
        imageEnhanced: !!imageUrls,
      }],
    });
    return {
      ebayListingId,
      ok: false,
      error: message,
    };
  }
  revalidate();
  const warnings = [
    copyResult && !copyResult.ok ? `Copy: ${copyResult.error}` : null,
    imageResult && !imageResult.ok ? `Image: ${imageResult.error}` : null,
  ].filter((item): item is string => !!item);
  await recordListingActivity({
    userId: user.id,
    source: "AI_OPTIMIZATION",
    improveMainImage: user.improveMainImage,
    improveListingContent: user.improveListingContent,
    items: [{
      title: title ?? listing.title,
      listingId: listing.id,
      ebayListingId,
      amazonUrl: listing.product.supplierUrl,
      sourcePriceCents: listing.product.costCents,
      listingPriceCents: listing.priceCents,
      ok: true,
      imageEnhanced: !!imageUrls,
      imageError: imageResult && !imageResult.ok ? imageResult.error : null,
    }],
  });
  return {
    ebayListingId,
    ok: true,
    title: title ?? listing.title,
    imageUrl: imageUrls?.[0] ?? firstImage(listing.imageUrlsJson),
    contentEnhanced: !!title,
    imageEnhanced: !!imageUrls,
    imageWarning:
      imageResult && !imageResult.ok ? imageResult.error : undefined,
    contentWarning:
      copyResult && !copyResult.ok ? copyResult.error : undefined,
    warning: warnings.join(" ") || undefined,
  };
}

/** End a live eBay listing (any origin). */
async function endEbayListingForUser(
  userId: string,
  ebayListingId: string,
  endedReason: "MANUAL" | "SOURCE_UNAVAILABLE" = "MANUAL",
): Promise<EbayListingResult> {
  const listing = await db.listing.findFirst({
    where: { userId, ebayListingId },
    include: { product: true },
  });
  const client = await getEbayClientForUser(userId);
  try {
    await client.endListing(ebayListingId);
  } catch (e) {
    if (e instanceof EbayApiError) {
      if (!isAlreadyEndedEbayError(e.message)) {
        await recordListingActivity({
          userId,
          source: endedReason === "SOURCE_UNAVAILABLE" ? "LISTING_SYNC" : "LISTING_END",
          trigger: endedReason === "SOURCE_UNAVAILABLE" ? "AUTOMATIC" : "MANUAL",
          items: [{
            title: listing?.title ?? `eBay listing ${ebayListingId}`,
            listingId: listing?.id,
            ebayListingId,
            amazonUrl: listing?.product.supplierUrl,
            sourcePriceCents: listing?.product.costCents,
            listingPriceCents: listing?.priceCents,
            ok: false,
            error: e.message,
          }],
        });
        return { error: e.message };
      }
    } else {
      throw e;
    }
  }
  await db.$transaction([
    db.listing.updateMany({
      where: { userId, ebayListingId },
      data: { status: "ENDED", endedAt: new Date(), endedReason },
    }),
    db.ebayListingSuppression.upsert({
      where: { userId_ebayListingId: { userId, ebayListingId } },
      create: { userId, ebayListingId },
      update: {},
    }),
  ]);
  await recordListingActivity({
    userId,
    source: endedReason === "SOURCE_UNAVAILABLE" ? "LISTING_SYNC" : "LISTING_END",
    trigger: endedReason === "SOURCE_UNAVAILABLE" ? "AUTOMATIC" : "MANUAL",
    items: [{
      title: listing?.title ?? `eBay listing ${ebayListingId}`,
      listingId: listing?.id,
      ebayListingId,
      amazonUrl: listing?.product.supplierUrl,
      sourcePriceCents: listing?.product.costCents,
      listingPriceCents: listing?.priceCents,
      ok: true,
    }],
  });
  return {};
}

export async function endEbayListing(
  ebayListingId: string,
): Promise<EbayListingResult> {
  const user = await requireUser();
  const result = await endEbayListingForUser(user.id, ebayListingId);
  revalidate();
  return result;
}

export type CleanupItemResult = {
  ebayListingId: string;
  listingId?: string;
  title?: string;
  action: "ok" | "repriced" | "ended" | "error";
  originalPriceCents?: number;
  newPriceCents?: number;
  suggestedPriceCents?: number;
  amazonPriceCents?: number;
  amazonShippingCents?: number;
  amazonUrl?: string;
  sku?: string;
  profitCents?: number;
  marginPct?: number;
  buyerShippingCents?: number;
  shippingStrategy?: string;
  error?: string;
};

/** How many listings one clean-up batch call processes. */
// Keep each live-price verification in its own request. One item can require
// a parent lookup, a child lookup, identity verification, and an eBay update;
// grouping four sequential items made a slow provider response hold the whole
// batch near the production function limit.
const CLEANUP_BATCH_SIZE = 1;

/**
 * Apply suggested prices to a batch of tracked listings using the shared
 * administrator Amazon catalog. A first-seen ASIN performs one provider lookup
 * and saves it globally; later sellers reuse that snapshot. The server
 * recalculates the recommendation from the trusted cost plus the seller's own
 * fee settings, so manipulated client data cannot set the live price. This
 * workflow never ends a listing.
 */
export async function cleanupEbayListings(
  items: Array<{
    ebayListingId: string;
    currentEbayPriceCents: number;
    suggestedPriceCents: number | null;
    ebayRecommendedPriceCents?: number | null;
    averageCompetitorPriceCents?: number | null;
  }>,
): Promise<CleanupItemResult[]> {
  const user = await requireUser();
  const winnerListings = await getProtectedPriceListings(user.id, user.ebayAdRateBps);
  const client = await getEbayClientForUser(user.id);
  const results: CleanupItemResult[] = [];

  for (const item of items.slice(0, CLEANUP_BATCH_SIZE)) {
    const { ebayListingId } = item;
    const listing = await db.listing.findFirst({
      where: { userId: user.id, ebayListingId, status: "ACTIVE" },
      include: { product: true },
    });
    if (!listing) {
      results.push({ ebayListingId, action: "error", error: "Not tracked/active" });
      continue;
    }
    const resultIdentity = {
      ebayListingId,
      listingId: listing.id,
      title: listing.title,
      originalPriceCents: listing.priceCents,
    };
    let attemptedPriceCents = item.suggestedPriceCents ?? undefined;
    if (winnerListings.has(listing.id)) {
      results.push({
        ...resultIdentity,
        action: "ok",
        newPriceCents: listing.priceCents,
        suggestedPriceCents: listing.priceCents,
      });
      continue;
    }
    try {
      const asin = listing.product.supplierProductId.trim().toUpperCase();
      const adminSource = await getAdminAmazonSourceWithFallback(asin);
      if (!adminSource.amazonInStock) {
        results.push({
          ...resultIdentity,
          action: "error",
          error: "The admin catalog currently marks this Amazon product out of stock.",
        });
        continue;
      }
      const plan = listingPricePlan({ amazonCostCents: adminSource.amazonPriceCents, amazonShippingCents: adminSource.amazonShippingCents, currentEbayPriceCents: listing.priceCents, ebayRecommendedPriceCents: adminSource.ebayRecommendedPriceCents, averageCompetitorPriceCents: adminSource.averageCompetitorPriceCents, sitewideDiscountBps: user.ebaySitewideDiscountBps, adRateBps: user.ebayAdRateBps, targetProfitCents: user.targetProfitEnabled ? user.targetProfitCents : null, pricingStrategy: user.pricingStrategy });
      const newPriceCents = plan.itemPriceCents;
      attemptedPriceCents = newPriceCents;
      await db.product.update({
        where: { id: listing.product.id },
        data: {
          supplierProductId: adminSource.asin,
          supplierUrl: adminSource.amazonUrl,
          costCents: adminSource.amazonPriceCents,
          shippingCostCents: adminSource.amazonShippingCents,
          supplierStock: 50,
          suggestedPriceCents: newPriceCents,
        },
      });
      if (plan.buyerShippingCents === listing.buyerShippingCents && !isSuggestedPriceCandidate({
        currentPriceCents: listing.priceCents,
        suggestedPriceCents: newPriceCents,
        amazonPriceCents: adminSource.amazonPriceCents,
        shippingCostCents: adminSource.amazonShippingCents,
        sitewideDiscountBps: user.ebaySitewideDiscountBps,
        adRateBps: user.ebayAdRateBps,
      })) {
        results.push({
          ...resultIdentity,
          action: "ok",
          newPriceCents: listing.priceCents,
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: adminSource.amazonPriceCents,
          amazonShippingCents: adminSource.amazonShippingCents,
          amazonUrl: adminSource.amazonUrl,
          sku: adminSource.asin,
        });
        continue;
      }
      if (newPriceCents !== listing.priceCents || plan.buyerShippingCents !== listing.buyerShippingCents) {
        const listingUpdate = {
          priceCents: newPriceCents,
          ...(plan.buyerShippingCents !== listing.buyerShippingCents && {
            buyerShippingCents: plan.buyerShippingCents,
          }),
        };
        let repairedImageUrls: string[] | undefined;
        try {
          await client.updateListing(ebayListingId, listingUpdate);
        } catch (updateError) {
          const updateMessage = updateError instanceof Error ? updateError.message : "eBay price update failed";
          if (!isEbayPicturePolicyError(updateMessage)) throw updateError;
          const prepared = await prepareEbayImages(user.id, parseImageUrls(listing.imageUrlsJson));
          if (prepared.imageUrls.length === 0) {
            throw new Error("The listing image does not meet eBay's 500-pixel requirement and no compliant replacement could be prepared.");
          }
          repairedImageUrls = prepared.imageUrls;
          await client.updateListing(ebayListingId, {
            ...listingUpdate,
            imageUrls: repairedImageUrls,
          });
        }
        await db.listing.update({
          where: { id: listing.id },
          data: {
            priceCents: newPriceCents,
            buyerShippingCents: plan.buyerShippingCents,
            shippingStrategy: plan.shippingStrategy,
            ...(repairedImageUrls && { imageUrlsJson: serializeImageUrls(repairedImageUrls) }),
          },
        });
        const buyerTotalCents = discountedEbayPriceCents(newPriceCents, user.ebaySitewideDiscountBps) + plan.buyerShippingCents;
        results.push({
          ...resultIdentity,
          action: "repriced",
          newPriceCents,
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: adminSource.amazonPriceCents,
          amazonShippingCents: adminSource.amazonShippingCents,
          amazonUrl: adminSource.amazonUrl,
          sku: adminSource.asin,
          profitCents: plan.modeledProfitCents,
          marginPct: buyerTotalCents > 0 ? Math.round(plan.modeledProfitCents / buyerTotalCents * 100) : 0,
          buyerShippingCents: plan.buyerShippingCents,
          shippingStrategy: plan.shippingStrategy,
        });
      } else {
        results.push({
          ...resultIdentity,
          action: "ok",
          newPriceCents: listing.priceCents,
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: adminSource.amazonPriceCents,
          amazonShippingCents: adminSource.amazonShippingCents,
          amazonUrl: adminSource.amazonUrl,
          sku: adminSource.asin,
        });
      }
    } catch (e) {
      results.push({
        ...resultIdentity,
        action: "error",
        suggestedPriceCents: attemptedPriceCents,
        newPriceCents: attemptedPriceCents,
        error:
          e instanceof EbayApiError
            ? e.message.slice(0, 500)
            : e instanceof Error
              ? e.message.slice(0, 500)
              : "failed",
      });
    }
  }
  revalidate();
  return results;
}

export async function recordSuggestedPriceActivity(
  rawItems: CleanupItemResult[],
): Promise<{ batchId: string | null }> {
  const user = await requireUser();
  const items = rawItems.slice(0, 1_000);
  const ebayListingIds = [...new Set(items.map((item) => item.ebayListingId))];
  const listings = await db.listing.findMany({
    where: { userId: user.id, ebayListingId: { in: ebayListingIds } },
    include: { product: { select: { supplierUrl: true } } },
  });
  const listingByEbayId = new Map(listings.map((listing) => [listing.ebayListingId, listing]));
  const activityItems = items.flatMap((item) => {
    const listing = listingByEbayId.get(item.ebayListingId);
    if (!listing) return [];
    const updatedPriceCents = item.newPriceCents ?? item.suggestedPriceCents ?? item.originalPriceCents ?? listing.priceCents;
    return [{
      title: listing.title,
      listingId: listing.id,
      ebayListingId: item.ebayListingId,
      amazonUrl: listing.product.supplierUrl,
      sourcePriceCents: item.originalPriceCents ?? listing.priceCents,
      listingPriceCents: updatedPriceCents,
      ok: item.action !== "error",
      error: item.error ?? null,
    }];
  });
  const batchId = await recordListingActivity({
    userId: user.id,
    source: "PRICE_OPTIMIZATION",
    trigger: "MANUAL",
    items: activityItems,
  });
  revalidatePath("/mirror");
  revalidatePath("/listings");
  return { batchId };
}

export type SourceCleanupBatchResult = {
  processed: number;
  kept: number;
  replaced: number;
  ended: number;
  relisted: number;
  stillUnavailable: number;
  review: number;
  remaining: number;
  endedIds: string[];
  relistedIds: string[];
};

export type SmartSyncCandidate = {
  listingId: string;
  title: string;
};

export type EbaySnapshotRefreshResult = {
  status: "success" | "error";
  checked: number;
  cached: number;
  localUpdated: number;
  restored: number;
  untracked: number;
  error?: string;
};

export type SmartSyncItemResult = {
  listingId: string;
  ebayListingId: string | null;
  title: string;
  status: "success" | "needs_attention" | "error";
  outcome: "unchanged" | "updated" | "ended" | "relisted";
  actions: string[];
  originalPriceCents: number;
  newPriceCents: number;
  error?: string;
};

async function refreshEbayListingSnapshotsForUser(userId: string): Promise<EbaySnapshotRefreshResult> {
  const client = await getEbayClientForUser(userId);
  const response = await client.getSellerListings(userId);
  const remote = [...new Map(response.map((listing) => [listing.ebayListingId, listing])).values()];
  const local = await db.listing.findMany({
    where: { userId, ebayListingId: { in: remote.map((listing) => listing.ebayListingId) } },
    select: { id: true, ebayListingId: true, status: true, endedReason: true },
  });
  const localByEbayId = new Map(local.flatMap((listing) =>
    listing.ebayListingId ? [[listing.ebayListingId, listing] as const] : [],
  ));
  const now = new Date();
  let localUpdated = 0;
  let restored = 0;

  // Keep transactions small enough for hosted Postgres connection limits.
  for (let offset = 0; offset < remote.length; offset += 50) {
    const batch = remote.slice(offset, offset + 50);
    await db.$transaction(batch.flatMap((listing) => {
      const localListing = localByEbayId.get(listing.ebayListingId);
      const writes: Prisma.PrismaPromise<unknown>[] = [db.ebayListingSnapshot.upsert({
        where: { userId_ebayListingId: { userId, ebayListingId: listing.ebayListingId } },
        create: {
          userId,
          ebayListingId: listing.ebayListingId,
          title: listing.title,
          priceCents: listing.priceCents,
          url: listing.url,
          imageUrl: listing.imageUrl,
          quantity: listing.quantity,
          listingDate: listing.listingDate,
          lastSeenAt: now,
        },
        update: {
          title: listing.title,
          priceCents: listing.priceCents,
          url: listing.url,
          imageUrl: listing.imageUrl,
          quantity: listing.quantity,
          listingDate: listing.listingDate,
          lastSeenAt: now,
        },
      })];
      if (localListing) {
        localUpdated += 1;
        const shouldRestore = localListing.status === "ENDED" &&
          (localListing.endedReason === null || localListing.endedReason === "EBAY_ENDED");
        if (shouldRestore) restored += 1;
        writes.push(db.listing.update({
          where: { id: localListing.id },
          data: {
            title: listing.title,
            priceCents: listing.priceCents,
            ...(listing.quantity !== null && { quantity: listing.quantity }),
            ...(shouldRestore && { status: "ACTIVE", endedAt: null, endedReason: null }),
          },
        }));
      }
      return writes;
    }));
  }

  return {
    status: "success",
    checked: remote.length,
    cached: remote.length,
    localUpdated,
    restored,
    untracked: Math.max(0, remote.length - localUpdated),
  };
}

export async function prepareConfigurableSmartSync(
  options: SmartSyncOptions,
): Promise<{ candidates: SmartSyncCandidate[]; ebayRefresh?: EbaySnapshotRefreshResult; error?: string }> {
  const user = await requireUser();
  if (!hasSelectedSmartSyncOption(options)) {
    return { candidates: [], error: "Select at least one Smart Sync action." };
  }
  let ebayRefresh: EbaySnapshotRefreshResult | undefined;
  if (options.refreshEbayListings) {
    try {
      ebayRefresh = await refreshEbayListingSnapshotsForUser(user.id);
    } catch (error) {
      ebayRefresh = {
        status: "error",
        checked: 0,
        cached: 0,
        localUpdated: 0,
        restored: 0,
        untracked: 0,
        error: error instanceof Error ? error.message.slice(0, 500) : "eBay listing refresh failed.",
      };
    }
  }
  const activeListingActionSelected = options.refreshAmazonData ||
    options.applySuggestedPrices ||
    options.updateListingImages ||
    options.endUnavailableListings;
  const listingScopes = [
    ...(activeListingActionSelected
      ? [{ status: "ACTIVE" as const, ebayListingId: { not: null } }]
      : []),
    ...(options.relistRecoveredProducts
      ? [{ status: "ENDED" as const, endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] } }]
      : []),
  ];
  const candidates = listingScopes.length > 0
    ? await db.listing.findMany({
        where: { userId: user.id, OR: listingScopes },
        select: { id: true, title: true },
        orderBy: [{ status: "asc" }, { publishedAt: "asc" }, { id: "asc" }],
        take: 1_000,
      })
    : [];
  return {
    candidates: candidates.map((listing) => ({ listingId: listing.id, title: listing.title })),
    ebayRefresh,
  };
}

function adminListingImages(adminSource: {
  amazonImageUrl: string | null;
  amazonImageUrlsJson: string;
}): string[] {
  return [...new Set([
    ...parseImageUrls(adminSource.amazonImageUrlsJson),
    ...(adminSource.amazonImageUrl ? [adminSource.amazonImageUrl] : []),
  ])].slice(0, 12);
}

export async function processConfigurableSmartSyncItem(
  listingId: string,
  options: SmartSyncOptions,
): Promise<SmartSyncItemResult> {
  const user = await requireUser();
  if (!hasSelectedSmartSyncOption(options)) throw new Error("Select at least one Smart Sync action.");
  const listing = await db.listing.findFirst({
    where: { id: listingId, userId: user.id },
    include: { product: true },
  });
  if (!listing) throw new Error("The listing is no longer available.");
  const base = {
    listingId: listing.id,
    ebayListingId: listing.ebayListingId,
    title: listing.title,
    originalPriceCents: listing.priceCents,
  };
  const actions: string[] = [];

  try {
    const asin = listing.product.supplierProductId.trim().toUpperCase();
    let adminSource: Awaited<ReturnType<typeof getAdminAmazonSourceWithFallback>>;
    try {
      adminSource = await getAdminAmazonSourceWithFallback(asin);
    } catch (error) {
      if (error instanceof NoUsableAmazonSourceError) {
        if (shouldEndUnavailableSourceListing({
          confirmedNoUsableSource: true,
          endUnavailableListings: options.endUnavailableListings,
          listingStatus: listing.status,
          hasEbayListingId: Boolean(listing.ebayListingId),
        }) && listing.ebayListingId) {
          const ended = await endEbayListingForUser(user.id, listing.ebayListingId, "SOURCE_UNAVAILABLE");
          if (ended.error) throw new Error(ended.error);
          actions.push("No usable Amazon source found");
          actions.push("Listing ended on eBay to prevent unfulfillable sales");
          return { ...base, status: "success", outcome: "ended", actions, newPriceCents: listing.priceCents };
        }
        return {
          ...base,
          status: "needs_attention",
          outcome: "unchanged",
          actions,
          newPriceCents: listing.priceCents,
          error: "No usable Amazon source was found. Select ‘End unavailable-source listings’ to delist it automatically.",
        };
      }
      throw error;
    }
    if (adminSource.sharedCatalogPopulated) actions.push("Amazon data retrieved once and saved to the admin catalog");

    if (options.refreshAmazonData) {
      await db.product.update({
        where: { id: listing.product.id },
        data: {
          title: adminSource.amazonTitle || listing.product.title,
          brand: adminSource.amazonBrand || listing.product.brand,
          description: adminSource.amazonDescription || listing.product.description,
          supplierUrl: adminSource.amazonUrl,
          costCents: adminSource.amazonPriceCents,
          shippingCostCents: adminSource.amazonShippingCents,
          supplierStock: adminSource.amazonInStock ? 50 : 0,
        },
      });
      actions.push("Amazon price and availability refreshed");
    }

    if (!adminSource.amazonInStock) {
      if (listing.status === "ACTIVE" && options.endUnavailableListings && listing.ebayListingId) {
        const ended = await endEbayListingForUser(user.id, listing.ebayListingId, "SOURCE_UNAVAILABLE");
        if (ended.error) throw new Error(ended.error);
        actions.push("Unavailable listing ended on eBay");
        return { ...base, status: "success", outcome: "ended", actions, newPriceCents: listing.priceCents };
      }
      return {
        ...base,
        status: "needs_attention",
        outcome: "unchanged",
        actions,
        newPriceCents: listing.priceCents,
        error: listing.status === "ENDED"
          ? "Amazon still marks this product unavailable, so it was not relisted."
          : "Amazon marks this product unavailable; ending unavailable listings is not selected.",
      };
    }

    const winnerListings = options.applySuggestedPrices
      ? await getProtectedPriceListings(user.id, user.ebayAdRateBps)
      : new Map();
    const priceLocked = winnerListings.has(listing.id);
    const plan = listingPricePlan({
      amazonCostCents: adminSource.amazonPriceCents,
      amazonShippingCents: adminSource.amazonShippingCents,
      currentEbayPriceCents: listing.priceCents,
      ebayRecommendedPriceCents: adminSource.ebayRecommendedPriceCents,
      averageCompetitorPriceCents: adminSource.averageCompetitorPriceCents,
      sitewideDiscountBps: user.ebaySitewideDiscountBps,
      adRateBps: user.ebayAdRateBps,
      targetProfitCents: user.targetProfitEnabled ? user.targetProfitCents : null,
      pricingStrategy: user.pricingStrategy,
    });
    const nextPriceCents = options.applySuggestedPrices && !priceLocked
      ? plan.itemPriceCents
      : listing.priceCents;
    const nextBuyerShippingCents = options.applySuggestedPrices && !priceLocked
      ? plan.buyerShippingCents
      : listing.buyerShippingCents;
    if (options.applySuggestedPrices && priceLocked) actions.push("Protected price preserved");

    let preparedImageUrls: string[] | undefined;
    let imageWarning: string | undefined;
    if (options.updateListingImages) {
      const sourceImages = adminListingImages(adminSource);
      if (sourceImages.length === 0) {
        imageWarning = "Administrator Amazon data has no product image; the current eBay images were preserved.";
      } else {
        const prepared = await prepareEbayImages(user.id, sourceImages);
        if (prepared.imageUrls.length === 0) {
          imageWarning = "No eBay-compliant Amazon image could be prepared; the current images were preserved.";
        } else {
          preparedImageUrls = prepared.imageUrls;
        }
      }
    }

    if (listing.status === "ENDED") {
      if (!options.relistRecoveredProducts) {
        return { ...base, status: imageWarning ? "needs_attention" : "success", outcome: "unchanged", actions, newPriceCents: nextPriceCents, ...(imageWarning && { error: imageWarning }) };
      }
      await db.listing.update({
        where: { id: listing.id },
        data: {
          priceCents: nextPriceCents,
          buyerShippingCents: nextBuyerShippingCents,
          shippingStrategy: nextBuyerShippingCents > 0 ? "BUYER_PAID_SHIPPING" : "FREE_SHIPPING",
          quantity: Math.max(1, listing.quantity),
          ...(preparedImageUrls && { imageUrlsJson: serializeImageUrls(preparedImageUrls) }),
        },
      });
      const published = await publishListingForUser(user.id, listing.id, {
        recoverEndedReasons: [...SMART_SYNC_RECOVERABLE_END_REASONS],
      });
      if (!published.ok) throw new Error(published.error);
      actions.push("Recovered product relisted on eBay");
      if (options.applySuggestedPrices && !priceLocked) actions.push("Suggested price applied");
      if (preparedImageUrls) actions.push("Amazon product images updated");
      return { ...base, ebayListingId: published.ebayListingId, status: imageWarning ? "needs_attention" : "success", outcome: "relisted", actions, newPriceCents: nextPriceCents, ...(imageWarning && { error: imageWarning }) };
    }

    if (!listing.ebayListingId) throw new Error("The active listing has no eBay item ID.");
    const listingUpdate: ListingUpdate = {};
    if (nextPriceCents !== listing.priceCents) listingUpdate.priceCents = nextPriceCents;
    if (nextBuyerShippingCents !== listing.buyerShippingCents) listingUpdate.buyerShippingCents = nextBuyerShippingCents;
    if (preparedImageUrls) listingUpdate.imageUrls = preparedImageUrls;
    if (Object.keys(listingUpdate).length > 0) {
      const client = await getEbayClientForUser(user.id);
      try {
        await client.updateListing(listing.ebayListingId, listingUpdate);
      } catch (updateError) {
        const message = updateError instanceof Error ? updateError.message : "eBay listing update failed";
        if (!isEbayPicturePolicyError(message) || preparedImageUrls) throw updateError;
        const repaired = await prepareEbayImages(user.id, parseImageUrls(listing.imageUrlsJson));
        if (repaired.imageUrls.length === 0) throw updateError;
        preparedImageUrls = repaired.imageUrls;
        await client.updateListing(listing.ebayListingId, { ...listingUpdate, imageUrls: preparedImageUrls });
      }
      await db.listing.update({
        where: { id: listing.id },
        data: {
          priceCents: nextPriceCents,
          buyerShippingCents: nextBuyerShippingCents,
          shippingStrategy: nextBuyerShippingCents > 0 ? "BUYER_PAID_SHIPPING" : "FREE_SHIPPING",
          ...(preparedImageUrls && { imageUrlsJson: serializeImageUrls(preparedImageUrls) }),
        },
      });
      if (nextPriceCents !== listing.priceCents || nextBuyerShippingCents !== listing.buyerShippingCents) actions.push("Suggested price applied");
      if (preparedImageUrls) actions.push("Amazon product images updated");
    }
    return {
      ...base,
      status: imageWarning ? "needs_attention" : "success",
      outcome: Object.keys(listingUpdate).length > 0 || actions.length > 0 ? "updated" : "unchanged",
      actions: actions.length > 0 ? actions : ["Already current"],
      newPriceCents: nextPriceCents,
      ...(imageWarning && { error: imageWarning }),
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      outcome: "unchanged",
      actions,
      newPriceCents: listing.priceCents,
      error: error instanceof Error ? error.message.slice(0, 500) : "Smart Sync failed for this listing.",
    };
  }
}

export async function startListingHealthSync(): Promise<{
  queued: number;
  activeQueued: number;
  recoveryQueued: number;
  freshSkipped: number;
}> {
  const user = await requireUser();
  const activeCutoff = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const recoveryCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const eligibleActive = {
    userId: user.id,
    status: "ACTIVE" as const,
    ebayListingId: { not: null },
    sourceMatchVerdict: { not: "PROCESSING" },
  };
  const activeTotal = await db.listing.count({ where: eligibleActive });
  const active = await db.listing.updateMany({
    where: {
      ...eligibleActive,
      OR: [
        { sourceMatchCheckedAt: null },
        { sourceMatchCheckedAt: { lt: activeCutoff } },
      ],
    },
    data: {
      sourceMatchVerdict: "UNVERIFIED",
      sourceMatchCheckedAt: null,
    },
  });
  const recovery = await db.listing.updateMany({
    where: {
      userId: user.id,
      status: "ENDED",
      endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] },
      OR: [
        { endedReason: "MANUAL" },
        {
          endedReason: "SOURCE_UNAVAILABLE",
          OR: [
            { sourceMatchCheckedAt: null },
            { sourceMatchCheckedAt: { lt: recoveryCutoff } },
          ],
        },
      ],
    },
    data: {
      sourceMatchVerdict: "UNVERIFIED",
      sourceMatchCheckedAt: null,
    },
  });
  revalidate();
  return {
    queued: active.count + recovery.count,
    activeQueued: active.count,
    recoveryQueued: recovery.count,
    freshSkipped: Math.max(0, activeTotal - active.count),
  };
}

function firstImage(json: string): string | null {
  try {
    const images = JSON.parse(json) as unknown;
    return Array.isArray(images) && typeof images[0] === "string" ? images[0] : null;
  } catch {
    return null;
  }
}

/**
 * Verify a few tracked live listings at a time. Wrong or unavailable sources
 * are replaced only by AI/rules-approved Amazon candidates. If the provider
 * research completes but no fulfillable equivalent exists, end the eBay item;
 * transient provider failures remain active for review and retry.
 */
export async function cleanupListingSourcesBatch(): Promise<SourceCleanupBatchResult> {
  const user = await requireUser();
  const winnerListings = await getProtectedPriceListings(user.id, user.ebayAdRateBps);
  // Recover work abandoned by a timed-out browser/server request.
  await db.listing.updateMany({
    where: {
      userId: user.id,
      OR: [
        { status: "ACTIVE", ebayListingId: { not: null } },
        { status: "ENDED", endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] } },
      ],
      sourceMatchVerdict: "PROCESSING",
      sourceMatchCheckedAt: { lt: new Date(Date.now() - 3 * 60 * 1000) },
    },
    data: { sourceMatchVerdict: "UNVERIFIED", sourceMatchCheckedAt: null },
  });
  const candidates = await db.listing.findMany({
    where: {
      userId: user.id,
      OR: [
        { status: "ACTIVE", ebayListingId: { not: null } },
        { status: "ENDED", endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] } },
      ],
      sourceMatchVerdict: "UNVERIFIED",
    },
    orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
    take: 8,
    select: { id: true },
  });
  let claimedId: string | null = null;
  for (const candidate of candidates) {
    const claimed = await db.listing.updateMany({
      where: {
        id: candidate.id,
        userId: user.id,
        OR: [
          { status: "ACTIVE", ebayListingId: { not: null } },
          { status: "ENDED", endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] } },
        ],
        sourceMatchVerdict: "UNVERIFIED",
      },
      data: { sourceMatchVerdict: "PROCESSING", sourceMatchCheckedAt: new Date() },
    });
    if (claimed.count === 1) {
      claimedId = candidate.id;
      break;
    }
  }
  const claimedListing = claimedId
    ? await db.listing.findUnique({ where: { id: claimedId }, include: { product: true } })
    : null;
  const listings = claimedListing ? [claimedListing] : [];
  const counts = {
    kept: 0,
    replaced: 0,
    ended: 0,
    relisted: 0,
    stillUnavailable: 0,
    review: 0,
  };
  const endedIds: string[] = [];
  const relistedIds: string[] = [];

  async function recoverIfEligible(listingId: string): Promise<{ ebayListingId?: string; error?: string }> {
    const recoverable = await db.listing.findFirst({
      where: {
        id: listingId,
        userId: user.id,
        status: "ENDED",
        endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] },
      },
      include: { product: true },
    });
    if (!recoverable) return {};
    const duplicate = await db.listing.findFirst({
      where: {
        userId: user.id,
        id: { not: recoverable.id },
        productId: recoverable.productId,
        status: "ACTIVE",
      },
      select: { ebayListingId: true },
    });
    if (duplicate) {
      return { error: "An active eBay listing already uses this recovered Amazon variant." };
    }
    const market = recoverable.ebayListingId
      ? await db.ebayMarketMetric.findUnique({
          where: {
            userId_ebayListingId: {
              userId: user.id,
              ebayListingId: recoverable.ebayListingId,
            },
          },
        })
      : null;
    const priceCents = winnerListings.has(recoverable.id)
      ? recoverable.priceCents
      : arbitrageSuggestedPriceCents(
          recoverable.product.costCents,
          recoverable.priceCents,
          market?.bestSellingPriceCents,
          market?.averageCompetitorPriceCents,
          recoverable.product.shippingCostCents,
          user.ebaySitewideDiscountBps,
          user.ebayAdRateBps,
          user.targetProfitEnabled ? user.targetProfitCents : null,
        );
    await db.listing.update({
      where: { id: recoverable.id },
      data: {
        priceCents,
        quantity: Math.max(1, Math.min(recoverable.quantity || 1, recoverable.product.supplierStock)),
      },
    });
    const published = await publishListingForUser(user.id, recoverable.id, {
      recoverEndedReasons: [...SMART_SYNC_RECOVERABLE_END_REASONS],
    });
    await recordListingActivity({
      userId: user.id,
      source: "LISTING_SYNC",
      trigger: "AUTOMATIC",
      items: [{
        title: recoverable.title,
        listingId: recoverable.id,
        ebayListingId: published.ok ? published.ebayListingId : recoverable.ebayListingId,
        amazonUrl: recoverable.product.supplierUrl,
        sourcePriceCents: recoverable.product.costCents,
        listingPriceCents: priceCents,
        ok: published.ok,
        error: published.ok ? null : published.error,
      }],
    });
    return published.ok ? { ebayListingId: published.ebayListingId } : { error: published.error };
  }

  for (const listing of listings) {
    try {
      const ebayIdentity = {
        title: listing.title,
        imageUrl: firstImage(listing.imageUrlsJson),
      };
      const current = await assessProductMatch(
        ebayIdentity,
        { title: listing.product.title, imageUrl: firstImage(listing.product.imageUrlsJson) },
      );
      const exactCurrent = await resolveExactAmazonVariant(ebayIdentity, {
        asin: listing.product.supplierProductId,
        title: listing.product.title,
        priceCents: listing.product.costCents,
        shippingCostCents: listing.product.shippingCostCents,
        url: listing.product.supplierUrl,
        imageUrl: firstImage(listing.product.imageUrlsJson) ?? undefined,
      }, { workflow: "listing_health_sync" });
      const exactCurrentAssessment = exactCurrent?.variantAssessment ?? current;
      if (exactCurrent && isApprovedProductMatch(exactCurrentAssessment)) {
        const assessment = exactCurrentAssessment;
        const product = await db.product.upsert({
          where: { userId_sku: { userId: user.id, sku: exactCurrent.asin } },
          create: {
            userId: user.id,
            sku: exactCurrent.asin,
            title: exactCurrent.title,
            description: exactCurrent.title,
            imageUrlsJson: serializeImageUrls(exactCurrent.imageUrl ? [exactCurrent.imageUrl] : []),
            category: listing.product.category,
            supplierName: "Amazon",
            supplierProductId: exactCurrent.asin,
            supplierUrl: exactCurrent.url,
            costCents: exactCurrent.priceCents,
            supplierStock: 50,
            shippingCostCents: exactCurrent.shippingCostCents,
            suggestedPriceCents: listing.priceCents,
            sourceScore: assessment.confidence,
          },
          update: {
            title: exactCurrent.title,
            supplierProductId: exactCurrent.asin,
            supplierUrl: exactCurrent.url,
            costCents: exactCurrent.priceCents,
            shippingCostCents: exactCurrent.shippingCostCents,
            supplierStock: 50,
            sourceScore: assessment.confidence,
          },
        });
        await db.listing.update({
          where: { id: listing.id },
          data: {
            productId: product.id,
            sourceMatchVerdict: assessment.verdict,
            sourceMatchConfidence: assessment.confidence,
            sourceMatchReason: `Exact Amazon variant: ${assessment.reason}`,
            sourceMatchMethod: assessment.method,
            sourceMatchCheckedAt: new Date(),
          },
        });
        if (listing.status === "ENDED") {
          const recovered = await recoverIfEligible(listing.id);
          if (recovered.ebayListingId) {
            counts.relisted++;
            relistedIds.push(recovered.ebayListingId);
          } else if (recovered.error) {
            await db.listing.update({
              where: { id: listing.id },
              data: {
                sourceMatchVerdict: "REVIEW",
                sourceMatchReason: `Amazon source recovered, but eBay relisting failed: ${recovered.error}`.slice(0, 240),
                sourceMatchCheckedAt: new Date(),
              },
            });
            counts.review++;
          }
          continue;
        }
        if (exactCurrent.asin === listing.product.supplierProductId) {
          counts.kept++;
        } else {
          await recordListingActivity({
            userId: user.id,
            source: "LISTING_SYNC",
            trigger: "AUTOMATIC",
            items: [{
              title: listing.title,
              listingId: listing.id,
              ebayListingId: listing.ebayListingId,
              amazonUrl: exactCurrent.url,
              sourcePriceCents: exactCurrent.priceCents,
              listingPriceCents: listing.priceCents,
              ok: true,
            }],
          });
          counts.replaced++;
        }
        continue;
      }

      const candidates = await findAmazonMatches(listing.title, 5, {
        throwOnError: true,
        workflow: "listing_source_repair_search",
      });
      let replacement: {
        candidate: NonNullable<Awaited<ReturnType<typeof resolveExactAmazonVariant>>>;
        assessment: Awaited<ReturnType<typeof assessProductMatch>>;
      } | null = null;
      // Never buy five variant lookups simultaneously. Rule-reject for free,
      // then validate the best two sequentially and stop on the first success.
      const repairCandidates = candidates
        .filter((candidate) => candidate.asin !== listing.product.sku)
        .filter(
          (candidate) =>
            assessProductMatchRules(listing.title, candidate.title).verdict !== "REJECTED",
        )
        .slice(0, 2);
      for (const candidate of repairCandidates) {
        const exact = await resolveExactAmazonVariant(ebayIdentity, candidate, {
          workflow: "listing_source_repair_variant",
        });
        if (!exact) continue;
        const assessment =
          exact.variantAssessment ??
          (await assessProductMatch(ebayIdentity, {
            title: exact.title,
            imageUrl: exact.imageUrl,
          }));
        if (isApprovedProductMatch(assessment)) {
          replacement = { candidate: exact, assessment };
          break;
        }
      }

      if (replacement) {
        const { candidate, assessment } = replacement;
        await db.$transaction(async (tx) => {
          const product = await tx.product.upsert({
            where: { userId_sku: { userId: user.id, sku: candidate.asin } },
            create: {
              userId: user.id,
              sku: candidate.asin,
              title: candidate.title,
              description: candidate.title,
              imageUrlsJson: serializeImageUrls(candidate.imageUrl ? [candidate.imageUrl] : []),
              category: listing.product.category,
              supplierName: "Amazon",
              supplierProductId: candidate.asin,
              supplierUrl: candidate.url,
              costCents: candidate.priceCents,
              supplierStock: 50,
              shippingCostCents: candidate.shippingCostCents,
              suggestedPriceCents: listing.priceCents,
              sourceScore: assessment.confidence,
            },
            update: {
              title: candidate.title,
              description: candidate.title,
              imageUrlsJson: serializeImageUrls(candidate.imageUrl ? [candidate.imageUrl] : []),
              supplierUrl: candidate.url,
              costCents: candidate.priceCents,
              shippingCostCents: candidate.shippingCostCents,
              supplierStock: 50,
              sourceScore: assessment.confidence,
            },
          });
          await tx.listing.update({
            where: { id: listing.id },
            data: {
              productId: product.id,
              sourceMatchVerdict: assessment.verdict,
              sourceMatchConfidence: assessment.confidence,
              sourceMatchReason: `Replacement source: ${assessment.reason}`,
              sourceMatchMethod: assessment.method,
              sourceMatchCheckedAt: new Date(),
            },
          });
          if (product.id !== listing.productId) {
            const oldProductUses = await tx.listing.count({
              where: { productId: listing.productId },
            });
            if (oldProductUses === 0) {
              await tx.product.delete({ where: { id: listing.productId } });
            }
          }
        });
        if (listing.status === "ENDED") {
          const recovered = await recoverIfEligible(listing.id);
          if (recovered.ebayListingId) {
            counts.relisted++;
            relistedIds.push(recovered.ebayListingId);
          } else if (recovered.error) {
            await db.listing.update({
              where: { id: listing.id },
              data: {
                sourceMatchVerdict: "REVIEW",
                sourceMatchReason: `Replacement source found, but eBay relisting failed: ${recovered.error}`.slice(0, 240),
                sourceMatchCheckedAt: new Date(),
              },
            });
            counts.review++;
          }
          continue;
        }
        await recordListingActivity({
          userId: user.id,
          source: "LISTING_SYNC",
          trigger: "AUTOMATIC",
          items: [{
            title: listing.title,
            listingId: listing.id,
            ebayListingId: listing.ebayListingId,
            amazonUrl: candidate.url,
            sourcePriceCents: candidate.priceCents,
            listingPriceCents: listing.priceCents,
            ok: true,
          }],
        });
        counts.replaced++;
        continue;
      }

      if (listing.status === "ENDED") {
        await db.listing.update({
          where: { id: listing.id },
          data: {
            // A manually ended listing gets one immediate recovery attempt.
            // If no source exists, future retries use normal provider safeguards.
            endedReason: "SOURCE_UNAVAILABLE",
            sourceMatchVerdict: "REJECTED",
            sourceMatchConfidence: current.confidence,
            sourceMatchReason: "Still unavailable: no fulfillable equivalent Amazon variant was found.",
            sourceMatchMethod: current.method,
            sourceMatchCheckedAt: new Date(),
          },
        });
        counts.stillUnavailable++;
        continue;
      }

      const ebayListingId = listing.ebayListingId;
      if (!ebayListingId) {
        counts.review++;
        continue;
      }
      await db.listing.update({
        where: { id: listing.id },
        data: {
          sourceMatchVerdict: "REJECTED",
          sourceMatchConfidence: current.confidence,
          sourceMatchReason: "No fulfillable equivalent Amazon variant was found during listing-health sync.",
          sourceMatchMethod: current.method,
          sourceMatchCheckedAt: new Date(),
        },
      });
      const ended = await endEbayListingForUser(
        user.id,
        ebayListingId,
        "SOURCE_UNAVAILABLE",
      );
      if (ended.error) {
        await db.listing.update({
          where: { id: listing.id },
          data: {
            sourceMatchVerdict: "REVIEW",
            sourceMatchConfidence: current.confidence,
            sourceMatchReason: `No fulfillable equivalent Amazon variant was found, but eBay could not end the listing: ${ended.error}`,
            sourceMatchMethod: current.method,
            sourceMatchCheckedAt: new Date(),
          },
        });
        counts.review++;
      } else {
        counts.ended++;
        endedIds.push(ebayListingId);
      }
    } catch (error) {
      await db.listing.update({
        where: { id: listing.id },
        data: {
          sourceMatchVerdict: "REVIEW",
          sourceMatchConfidence: null,
          sourceMatchReason:
            error instanceof Error ? error.message.slice(0, 240) : "Source verification failed.",
          sourceMatchMethod: null,
          sourceMatchCheckedAt: new Date(),
        },
      });
      counts.review++;
    }
  }

  const remaining = await db.listing.count({
    where: {
      userId: user.id,
      OR: [
        { status: "ACTIVE", ebayListingId: { not: null } },
        { status: "ENDED", endedReason: { in: [...SMART_SYNC_RECOVERABLE_END_REASONS] } },
      ],
      sourceMatchVerdict: { in: ["UNVERIFIED", "PROCESSING"] },
    },
  });
  revalidate();
  return { processed: listings.length, ...counts, remaining, endedIds, relistedIds };
}
