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
import { suggestedListingPriceCents } from "@/lib/listings/cleanup";
import { estimateMargin } from "@/lib/fees";
import { assessProductMatch, isApprovedProductMatch } from "@/lib/arbitrage/product-match";
import { findAmazonMatches } from "@/lib/mirror/match";
import { resolveExactAmazonVariant } from "@/lib/mirror/variant";
import { serializeImageUrls } from "@/lib/types";

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
): Promise<EbayListingResult> {
  const user = await requireUser();
  if (priceCents < 99) return { error: "Price must be at least $0.99" };

  const client = await getEbayClientForUser(user.id);
  try {
    await client.updateListing(ebayListingId, { priceCents });
  } catch (e) {
    if (e instanceof EbayApiError) return { error: e.message };
    throw e;
  }
  await db.listing.updateMany({
    where: { userId: user.id, ebayListingId },
    data: { priceCents },
  });
  revalidate();
  return {};
}

/** End a live eBay listing (any origin). */
async function endEbayListingForUser(
  userId: string,
  ebayListingId: string,
): Promise<EbayListingResult> {
  const client = await getEbayClientForUser(userId);
  try {
    await client.endListing(ebayListingId);
  } catch (e) {
    if (e instanceof EbayApiError) {
      if (!isAlreadyEndedEbayError(e.message)) return { error: e.message };
    } else {
      throw e;
    }
  }
  await db.$transaction([
    db.listing.updateMany({
      where: { userId, ebayListingId },
      data: { status: "ENDED", endedAt: new Date() },
    }),
    db.ebayListingSuppression.upsert({
      where: { userId_ebayListingId: { userId, ebayListingId } },
      create: { userId, ebayListingId },
      update: {},
    }),
  ]);
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
  amazonUrl?: string;
  sku?: string;
  profitCents?: number;
  marginPct?: number;
  error?: string;
};

/** How many listings one clean-up batch call processes. */
const CLEANUP_BATCH_SIZE = 4;

/**
 * Apply suggested prices to a batch of tracked listings. The server clamps
 * every requested price to the profitability floor, so stale or manipulated
 * client data can never push a live listing below the 30%-margin / $7-profit
 * target. This workflow never ends a listing.
 */
export async function cleanupEbayListings(
  items: Array<{
    ebayListingId: string;
    averageCompetitorPriceCents?: number | null;
  }>,
): Promise<CleanupItemResult[]> {
  const user = await requireUser();
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
    try {
      const exact = await resolveExactAmazonVariant(
        { title: listing.title, imageUrl: firstImage(listing.imageUrlsJson) },
        {
          asin: listing.product.supplierProductId,
          title: listing.product.title,
          priceCents: listing.product.costCents,
          url: listing.product.supplierUrl,
          imageUrl: firstImage(listing.product.imageUrlsJson) ?? undefined,
        },
      );
      if (!exact) {
        results.push({
          ebayListingId,
          action: "error",
          error: "Exact Amazon variant and live price could not be verified.",
        });
        continue;
      }
      const product = await db.product.upsert({
        where: { userId_sku: { userId: user.id, sku: exact.asin } },
        create: {
          userId: user.id,
          sku: exact.asin,
          title: exact.title,
          description: exact.title,
          imageUrlsJson: serializeImageUrls(exact.imageUrl ? [exact.imageUrl] : []),
          category: listing.product.category,
          supplierName: "Amazon",
          supplierProductId: exact.asin,
          supplierUrl: exact.url,
          costCents: exact.priceCents,
          supplierStock: 50,
          shippingCostCents: listing.product.shippingCostCents,
          suggestedPriceCents: listing.product.suggestedPriceCents,
          sourceScore: listing.product.sourceScore,
        },
        update: {
          title: exact.title,
          supplierProductId: exact.asin,
          supplierUrl: exact.url,
          costCents: exact.priceCents,
          supplierStock: 50,
        },
      });
      if (product.id !== listing.productId) {
        await db.listing.update({
          where: { id: listing.id },
          data: { productId: product.id },
        });
      }
      const newPriceCents = suggestedListingPriceCents(
        exact.priceCents,
        product.shippingCostCents,
        item.averageCompetitorPriceCents,
      );
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
          exact.priceCents,
          product.shippingCostCents,
        );
        results.push({
          ebayListingId,
          action: "repriced",
          newPriceCents,
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: exact.priceCents,
          amazonUrl: exact.url,
          sku: exact.asin,
          profitCents: margin.estimatedProfitCents,
          marginPct: Math.round(margin.marginPct),
        });
      } else {
        results.push({
          ebayListingId,
          action: "ok",
          suggestedPriceCents: newPriceCents,
          amazonPriceCents: exact.priceCents,
          amazonUrl: exact.url,
          sku: exact.asin,
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
  review: number;
  remaining: number;
  endedIds: string[];
};

export async function startListingHealthSync(): Promise<{ queued: number }> {
  const user = await requireUser();
  const queued = await db.listing.updateMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
      ebayListingId: { not: null },
      sourceMatchVerdict: { not: "PROCESSING" },
    },
    data: {
      sourceMatchVerdict: "UNVERIFIED",
      sourceMatchCheckedAt: null,
    },
  });
  revalidate();
  return { queued: queued.count };
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
  // Recover work abandoned by a timed-out browser/server request.
  await db.listing.updateMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
      sourceMatchVerdict: "PROCESSING",
      sourceMatchCheckedAt: { lt: new Date(Date.now() - 3 * 60 * 1000) },
    },
    data: { sourceMatchVerdict: "UNVERIFIED", sourceMatchCheckedAt: null },
  });
  const candidates = await db.listing.findMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
      ebayListingId: { not: null },
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
        status: "ACTIVE",
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
  const counts = { kept: 0, replaced: 0, ended: 0, review: 0 };
  const endedIds: string[] = [];

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
        url: listing.product.supplierUrl,
        imageUrl: firstImage(listing.product.imageUrlsJson) ?? undefined,
      });
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
            shippingCostCents: listing.product.shippingCostCents,
            suggestedPriceCents: listing.priceCents,
            sourceScore: assessment.confidence,
          },
          update: {
            title: exactCurrent.title,
            supplierProductId: exactCurrent.asin,
            supplierUrl: exactCurrent.url,
            costCents: exactCurrent.priceCents,
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
        if (exactCurrent.asin === listing.product.supplierProductId) counts.kept++;
        else counts.replaced++;
        continue;
      }

      const candidates = await findAmazonMatches(listing.title, 5, { throwOnError: true });
      const assessedCandidates = await Promise.all(
        candidates
          .filter((candidate) => candidate.asin !== listing.product.sku)
          .map(async (candidate) => {
            const exact = await resolveExactAmazonVariant(ebayIdentity, candidate);
            return exact
              ? {
                  candidate: exact,
                  assessment:
                    exact.variantAssessment ??
                    (await assessProductMatch(ebayIdentity, {
                      title: exact.title,
                      imageUrl: exact.imageUrl,
                    })),
                }
              : null;
          }),
      );
      const replacement = assessedCandidates.find(
        (value) => value !== null && isApprovedProductMatch(value.assessment),
      );

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
              shippingCostCents: 0,
              suggestedPriceCents: listing.priceCents,
              sourceScore: assessment.confidence,
            },
            update: {
              title: candidate.title,
              description: candidate.title,
              imageUrlsJson: serializeImageUrls(candidate.imageUrl ? [candidate.imageUrl] : []),
              supplierUrl: candidate.url,
              costCents: candidate.priceCents,
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
        counts.replaced++;
        continue;
      }

      const ebayListingId = listing.ebayListingId;
      if (!ebayListingId) {
        counts.review++;
        continue;
      }
      const ended = await endEbayListingForUser(user.id, ebayListingId);
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
      status: "ACTIVE",
      ebayListingId: { not: null },
      sourceMatchVerdict: { in: ["UNVERIFIED", "PROCESSING"] },
    },
  });
  revalidate();
  return { processed: listings.length, ...counts, remaining, endedIds };
}
