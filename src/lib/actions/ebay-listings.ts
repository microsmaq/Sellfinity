"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError } from "@/lib/ebay/client";
import { isAlreadyEndedEbayError } from "@/lib/ebay/errors";
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
import { estimateMargin } from "@/lib/fees";
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
import { targetNetProfitPriceCents, trueProfitCents } from "@/lib/listings/cleanup";
import { improveMainListingImage } from "@/lib/mirror/improve-main-image";
import { improveListingContent } from "@/lib/mirror/improve-listing-content";
import { generateMirrorDescription } from "@/lib/mirror/seo";
import { recordListingActivity } from "@/lib/listings/activity-history";
import { SMART_SYNC_RECOVERABLE_END_REASONS } from "@/lib/listings/smart-sync-policy";

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
  error?: string;
};

/** Set one seller listing to the minimum price that reaches a requested net
 * profit. Amazon pricing comes exclusively from the administrator-maintained
 * catalog, so this seller action cannot consume Rainforest credits. */
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
  const adminSource = await db.adminArbitrageProduct.findUnique({
    where: { asin },
    select: {
      asin: true,
      amazonPriceCents: true,
      amazonShippingCents: true,
      amazonUrl: true,
      amazonInStock: true,
    },
  });
  if (!adminSource || adminSource.amazonPriceCents <= 0) {
    return fail("No admin-stored Amazon price is available for this ASIN.");
  }
  if (!adminSource.amazonInStock) {
    return fail("The admin catalog currently marks this Amazon product out of stock.");
  }

  const newPriceCents = targetNetProfitPriceCents(
    adminSource.amazonPriceCents,
    adminSource.amazonShippingCents,
    target,
    user.ebaySitewideDiscountBps,
    user.ebayAdRateBps,
  );
  const modeledProfitCents = trueProfitCents(
    newPriceCents,
    adminSource.amazonPriceCents,
    adminSource.amazonShippingCents,
    user.ebaySitewideDiscountBps,
    user.ebayAdRateBps,
  );

  const client = await getEbayClientForUser(user.id);
  try {
    if (newPriceCents !== listing.priceCents) {
      await client.updateListing(ebayListingId, { priceCents: newPriceCents });
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
      data: { priceCents: newPriceCents },
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
  action: "ok" | "repriced" | "ended" | "error";
  newPriceCents?: number;
  suggestedPriceCents?: number;
  amazonPriceCents?: number;
  amazonShippingCents?: number;
  amazonUrl?: string;
  sku?: string;
  profitCents?: number;
  marginPct?: number;
  error?: string;
};

/** How many listings one clean-up batch call processes. */
// Keep each live-price verification in its own request. One item can require
// a parent lookup, a child lookup, identity verification, and an eBay update;
// grouping four sequential items made a slow provider response hold the whole
// batch near the production function limit.
const CLEANUP_BATCH_SIZE = 1;

/**
 * Apply suggested prices to a batch of tracked listings using only the
 * administrator-maintained Amazon catalog. Seller requests must never perform
 * a paid Amazon/Rainforest lookup. The server recalculates the recommendation
 * from the stored admin cost plus the seller's own fee settings, so stale or
 * manipulated client data cannot set the live price. This workflow never ends
 * a listing.
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
    if (winnerListings.has(listing.id)) {
      results.push({
        ebayListingId,
        action: "ok",
        suggestedPriceCents: listing.priceCents,
      });
      continue;
    }
    try {
      const asin = listing.product.supplierProductId.trim().toUpperCase();
      const adminSource = await db.adminArbitrageProduct.findUnique({
        where: { asin },
        select: {
          asin: true,
          amazonPriceCents: true,
          amazonShippingCents: true,
          amazonUrl: true,
          amazonInStock: true,
          ebayRecommendedPriceCents: true,
          averageCompetitorPriceCents: true,
        },
      });
      if (!adminSource || adminSource.amazonPriceCents <= 0) {
        results.push({
          ebayListingId,
          action: "error",
          error: "No admin-stored Amazon price is available for this ASIN.",
        });
        continue;
      }
      if (!adminSource.amazonInStock) {
        results.push({
          ebayListingId,
          action: "error",
          error: "The admin catalog currently marks this Amazon product out of stock.",
        });
        continue;
      }
      const newPriceCents = arbitrageSuggestedPriceCents(
        adminSource.amazonPriceCents,
        listing.priceCents,
        adminSource.ebayRecommendedPriceCents,
        adminSource.averageCompetitorPriceCents,
        adminSource.amazonShippingCents,
        user.ebaySitewideDiscountBps,
        user.ebayAdRateBps,
        user.targetProfitEnabled ? user.targetProfitCents : null,
      );
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
      if (!isSuggestedPriceCandidate({
        currentPriceCents: listing.priceCents,
        suggestedPriceCents: newPriceCents,
        amazonPriceCents: adminSource.amazonPriceCents,
        shippingCostCents: adminSource.amazonShippingCents,
        sitewideDiscountBps: user.ebaySitewideDiscountBps,
        adRateBps: user.ebayAdRateBps,
      })) {
        results.push({
          ebayListingId,
          action: "ok",
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: adminSource.amazonPriceCents,
          amazonShippingCents: adminSource.amazonShippingCents,
          amazonUrl: adminSource.amazonUrl,
          sku: adminSource.asin,
        });
        continue;
      }
      if (newPriceCents !== listing.priceCents) {
        await client.updateListing(ebayListingId, {
          priceCents: newPriceCents,
        });
        await db.listing.update({
          where: { id: listing.id },
          data: { priceCents: newPriceCents },
        });
        const margin = estimateMargin(
          newPriceCents,
          adminSource.amazonPriceCents,
          adminSource.amazonShippingCents,
          user.ebaySitewideDiscountBps,
          user.ebayAdRateBps,
        );
        results.push({
          ebayListingId,
          action: "repriced",
          newPriceCents,
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: adminSource.amazonPriceCents,
          amazonShippingCents: adminSource.amazonShippingCents,
          amazonUrl: adminSource.amazonUrl,
          sku: adminSource.asin,
          profitCents: margin.estimatedProfitCents,
          marginPct: Math.round(margin.marginPct),
        });
      } else {
        results.push({
          ebayListingId,
          action: "ok",
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: adminSource.amazonPriceCents,
          amazonShippingCents: adminSource.amazonShippingCents,
          amazonUrl: adminSource.amazonUrl,
          sku: adminSource.asin,
        });
      }
    } catch (e) {
      results.push({
        ebayListingId,
        action: "error",
        error:
          e instanceof EbayApiError
            ? e.message.slice(0, 150)
            : e instanceof Error
              ? e.message.slice(0, 150)
              : "failed",
      });
    }
  }
  revalidate();
  return results;
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
