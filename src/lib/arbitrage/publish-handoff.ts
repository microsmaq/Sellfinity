import { db } from "@/lib/db";
import { researchEbayMarket } from "@/lib/ebay/market";
import { marketSearchQuery } from "@/lib/ebay/market-analysis";
import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";

/** Carry the scanner's verified Amazon/eBay identity onto the listing created
 * by the generic Amazon mirroring pipeline. */
export async function attachArbitrageResearchToListing(
  userId: string,
  listingId: string,
  ebayItemId: string,
): Promise<void> {
  const opportunity = await db.arbitrageItem.findUnique({
    where: { ebayItemId },
    select: {
      matchVerdict: true,
      matchConfidence: true,
      matchReason: true,
      matchMethod: true,
      matchCheckedAt: true,
    },
  });
  if (!opportunity) return;
  await db.listing.updateMany({
    where: { id: listingId, userId },
    data: {
      sourceMatchVerdict: opportunity.matchVerdict,
      sourceMatchConfidence: opportunity.matchConfidence,
      sourceMatchReason: opportunity.matchReason,
      sourceMatchMethod: opportunity.matchMethod,
      sourceMatchCheckedAt: opportunity.matchCheckedAt ?? new Date(),
    },
  });
}

/** Retain discovery metrics under the seller's new eBay listing ID so the
 * Listings screen can assess competitiveness immediately. Missing historical
 * fields are researched once; a conservative snapshot still survives a
 * temporary eBay lookup failure. */
export async function retainPublishedArbitrageResearch(
  userId: string,
  listingId: string,
  ebayListingId: string,
  sourceEbayItemId: string,
): Promise<void> {
  const [listing, opportunity] = await Promise.all([
    db.listing.findFirst({ where: { id: listingId, userId }, select: { title: true } }),
    db.arbitrageItem.findUnique({ where: { ebayItemId: sourceEbayItemId } }),
  ]);
  if (!listing || !opportunity) return;

  let researched: { query: string; metrics: ListingMarketMetrics } | null = null;
  if (
    opportunity.competitorCount === null ||
    opportunity.avgCompPriceCents === null ||
    opportunity.bestSellingPriceCents === null
  ) {
    try {
      researched = await researchEbayMarket(listing.title, ebayListingId);
    } catch {
      // The retained discovery comp below guarantees populated, sortable data;
      // Research market data / Smart Sync can refresh it later.
    }
  }

  const metrics: ListingMarketMetrics = researched?.metrics ?? {
    estimatedSales30d: opportunity.salesEst,
    competitorCount: opportunity.competitorCount ?? 1,
    averageCompetitorPriceCents:
      opportunity.avgCompPriceCents ?? opportunity.ebayPriceCents,
    bestSellingPriceCents:
      opportunity.bestSellingPriceCents ??
      opportunity.avgCompPriceCents ??
      opportunity.ebayPriceCents,
  };
  const query = researched?.query ?? marketSearchQuery(listing.title) ?? listing.title;

  await db.$transaction([
    db.arbitrageItem.update({
      where: { ebayItemId: sourceEbayItemId },
      data: {
        salesEst: metrics.estimatedSales30d,
        competitorCount: metrics.competitorCount,
        avgCompPriceCents: metrics.averageCompetitorPriceCents,
        bestSellingPriceCents: metrics.bestSellingPriceCents,
      },
    }),
    db.ebayMarketMetric.upsert({
      where: { userId_ebayListingId: { userId, ebayListingId } },
      create: {
        userId,
        ebayListingId,
        query,
        ...metrics,
      },
      update: { query, ...metrics },
    }),
  ]);
}

/** Repair older Arbitrage publications created before research handoff was
 * implemented. Batch item references make this exact and avoid title/ASIN
 * guessing. No external provider calls or paid credits are used. */
export async function backfillRetainedArbitrageResearchForUser(
  userId: string,
  limit = 100,
): Promise<number> {
  const batchItems = await db.mirrorBatchItem.findMany({
    where: {
      batch: { userId, source: "ARBITRAGE" },
      status: "SUCCEEDED",
      listingId: { not: null },
      sourceReferenceId: { not: null },
    },
    orderBy: { completedAt: "desc" },
    take: Math.max(1, Math.min(500, limit)),
    select: { listingId: true, sourceReferenceId: true },
  });
  const listingIds = batchItems
    .map((item) => item.listingId)
    .filter((id): id is string => !!id);
  if (listingIds.length === 0) return 0;
  const listings = await db.listing.findMany({
    where: { id: { in: listingIds }, userId, ebayListingId: { not: null } },
    select: {
      id: true,
      ebayListingId: true,
      sourceMatchVerdict: true,
    },
  });
  const refsByListing = new Map<string, string>();
  for (const item of batchItems) {
    if (
      item.listingId &&
      item.sourceReferenceId &&
      !refsByListing.has(item.listingId)
    ) {
      refsByListing.set(item.listingId, item.sourceReferenceId);
    }
  }
  const opportunityIds = [
    ...new Set(
      listings
        .map((listing) => refsByListing.get(listing.id))
        .filter((id): id is string => !!id),
    ),
  ];
  const opportunities = await db.arbitrageItem.findMany({
    where: { ebayItemId: { in: opportunityIds } },
  });
  const opportunitiesById = new Map(
    opportunities.map((item) => [item.ebayItemId, item]),
  );
  const existingMetrics = await db.ebayMarketMetric.findMany({
    where: {
      userId,
      ebayListingId: {
        in: listings
          .map((listing) => listing.ebayListingId)
          .filter((id): id is string => !!id),
      },
    },
    select: { ebayListingId: true },
  });
  const metricIds = new Set(existingMetrics.map((metric) => metric.ebayListingId));
  let repaired = 0;
  for (const listing of listings) {
    const ebayListingId = listing.ebayListingId;
    const opportunityId = refsByListing.get(listing.id);
    const opportunity = opportunityId
      ? opportunitiesById.get(opportunityId)
      : undefined;
    if (!ebayListingId || !opportunity) continue;
    const operations = [];
    if (listing.sourceMatchVerdict === "UNVERIFIED") {
      operations.push(
        db.listing.update({
          where: { id: listing.id },
          data: {
            sourceMatchVerdict: opportunity.matchVerdict,
            sourceMatchConfidence: opportunity.matchConfidence,
            sourceMatchReason: opportunity.matchReason,
            sourceMatchMethod: opportunity.matchMethod,
            sourceMatchCheckedAt: opportunity.matchCheckedAt ?? new Date(),
          },
        }),
      );
    }
    if (!metricIds.has(ebayListingId)) {
      const metrics = {
        estimatedSales30d: opportunity.salesEst,
        competitorCount: opportunity.competitorCount ?? 1,
        averageCompetitorPriceCents:
          opportunity.avgCompPriceCents ?? opportunity.ebayPriceCents,
        bestSellingPriceCents:
          opportunity.bestSellingPriceCents ??
          opportunity.avgCompPriceCents ??
          opportunity.ebayPriceCents,
      };
      operations.push(
        db.ebayMarketMetric.upsert({
          where: { userId_ebayListingId: { userId, ebayListingId } },
          create: {
            userId,
            ebayListingId,
            query: marketSearchQuery(opportunity.ebayTitle) || opportunity.ebayTitle,
            ...metrics,
          },
          update: {},
        }),
      );
    }
    if (operations.length > 0) {
      await db.$transaction(operations);
      repaired++;
    }
  }
  return repaired;
}
