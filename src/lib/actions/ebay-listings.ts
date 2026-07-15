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
import { targetPriceCents } from "@/lib/listings/cleanup";
import { estimateMargin } from "@/lib/fees";
import { assessProductMatch, isApprovedProductMatch } from "@/lib/arbitrage/product-match";
import { findAmazonMatches } from "@/lib/mirror/match";
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
export async function endEbayListing(
  ebayListingId: string,
): Promise<EbayListingResult> {
  const user = await requireUser();
  const client = await getEbayClientForUser(user.id);
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
      where: { userId: user.id, ebayListingId },
      data: { status: "ENDED", endedAt: new Date() },
    }),
    db.ebayListingSuppression.upsert({
      where: { userId_ebayListingId: { userId: user.id, ebayListingId } },
      create: { userId: user.id, ebayListingId },
      update: {},
    }),
  ]);
  revalidate();
  return {};
}

export type CleanupItemResult = {
  ebayListingId: string;
  action: "ok" | "repriced" | "ended" | "error";
  newPriceCents?: number;
  profitCents?: number;
  marginPct?: number;
  error?: string;
};

/** How many listings one clean-up batch call processes. */
const CLEANUP_BATCH_SIZE = 10;

/**
 * Apply suggested prices to a batch of tracked listings. The server clamps
 * every requested price to the profitability floor, so stale or manipulated
 * client data can never push a live listing below the 30%-margin / $7-profit
 * target. This workflow never ends a listing.
 */
export async function cleanupEbayListings(
  items: Array<{ ebayListingId: string; suggestedPriceCents: number }>,
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
    const profitableFloor = targetPriceCents(
      listing.product.costCents,
      listing.product.shippingCostCents,
    );
    const requestedPrice = Number.isSafeInteger(item.suggestedPriceCents)
      ? item.suggestedPriceCents
      : profitableFloor;
    const newPriceCents = Math.max(profitableFloor, requestedPrice);
    try {
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
          listing.product.costCents,
          listing.product.shippingCostCents,
        );
        results.push({
          ebayListingId,
          action: "repriced",
          newPriceCents,
          profitCents: margin.estimatedProfitCents,
          marginPct: Math.round(margin.marginPct),
        });
      } else {
        results.push({ ebayListingId, action: "ok" });
      }
    } catch (e) {
      results.push({
        ebayListingId,
        action: "error",
        error: e instanceof EbayApiError ? e.message.slice(0, 150) : "failed",
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

function firstImage(json: string): string | null {
  try {
    const images = JSON.parse(json) as unknown;
    return Array.isArray(images) && typeof images[0] === "string" ? images[0] : null;
  } catch {
    return null;
  }
}

/**
 * Verify a few tracked live listings at a time. Wrong sources are replaced
 * only by AI/rules-approved Amazon candidates. If the current pair is
 * definitively wrong and no safe replacement exists, the live eBay listing is
 * ended so the seller cannot receive an order they cannot fulfill.
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
  const client = await getEbayClientForUser(user.id);
  const counts = { kept: 0, replaced: 0, ended: 0, review: 0 };
  const endedIds: string[] = [];

  for (const listing of listings) {
    const ebayListingId = listing.ebayListingId!;
    try {
      const current = await assessProductMatch(
        { title: listing.title, imageUrl: firstImage(listing.imageUrlsJson) },
        { title: listing.product.title, imageUrl: firstImage(listing.product.imageUrlsJson) },
      );
      if (isApprovedProductMatch(current)) {
        await db.listing.update({
          where: { id: listing.id },
          data: {
            sourceMatchVerdict: current.verdict,
            sourceMatchConfidence: current.confidence,
            sourceMatchReason: current.reason,
            sourceMatchMethod: current.method,
            sourceMatchCheckedAt: new Date(),
          },
        });
        counts.kept++;
        continue;
      }

      const candidates = await findAmazonMatches(listing.title, 5, { throwOnError: true });
      const assessedCandidates = await Promise.all(
        candidates
          .filter((candidate) => candidate.asin !== listing.product.sku)
          .map(async (candidate) => ({
            candidate,
            assessment: await assessProductMatch(
              { title: listing.title, imageUrl: firstImage(listing.imageUrlsJson) },
              { title: candidate.title, imageUrl: candidate.imageUrl },
            ),
          })),
      );
      const replacement = assessedCandidates.find(({ assessment }) =>
        isApprovedProductMatch(assessment),
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

      // A rules-only REVIEW means the AI service was unavailable or the title
      // evidence is genuinely ambiguous. Never end a live listing on that.
      if (current.verdict === "REVIEW" && current.method === "RULES") {
        await db.listing.update({
          where: { id: listing.id },
          data: {
            sourceMatchVerdict: "REVIEW",
            sourceMatchConfidence: current.confidence,
            sourceMatchReason: current.reason,
            sourceMatchMethod: current.method,
            sourceMatchCheckedAt: new Date(),
          },
        });
        counts.review++;
        continue;
      }

      try {
        await client.endListing(ebayListingId);
      } catch (error) {
        if (!(error instanceof EbayApiError) || !isAlreadyEndedEbayError(error.message)) {
          throw error;
        }
      }
      await db.$transaction([
        db.listing.update({
          where: { id: listing.id },
          data: {
            status: "ENDED",
            endedAt: new Date(),
            sourceMatchVerdict: current.verdict,
            sourceMatchConfidence: current.confidence,
            sourceMatchReason: `No equivalent Amazon source found. ${current.reason}`,
            sourceMatchMethod: current.method,
            sourceMatchCheckedAt: new Date(),
          },
        }),
        db.ebayListingSuppression.upsert({
          where: { userId_ebayListingId: { userId: user.id, ebayListingId } },
          create: { userId: user.id, ebayListingId },
          update: {},
        }),
      ]);
      counts.ended++;
      endedIds.push(ebayListingId);
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
