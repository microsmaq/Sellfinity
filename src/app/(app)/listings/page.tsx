import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { buildEbayRows } from "@/lib/listings/ebay-rows";
import { getListingMarketMetrics } from "@/lib/listings/market-metrics";
import { parseImageUrls } from "@/lib/types";
import { PageHeader, Badge } from "@/components/ui";
import { ListingsView, type ListingRow, type UnlistedRow } from "./listings-view";
import type { EbayRow } from "./ebay-listings-table";
import { backfillRetainedArbitrageResearchForUser } from "@/lib/arbitrage/publish-handoff";
import { getListingPriceProtection } from "@/lib/listings/winner";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { summarize, windowStartUtc } from "@/lib/orders/stats";
import { listingPricePlan } from "@/lib/listings/shipping-strategy";
import { retainedEbayListings } from "@/lib/listings/local-ebay-cache";

export const metadata = { title: "Listings — Sellfinity" };

// GPT Image 2 edits can legitimately take longer than one minute. Listing
// server actions inherit this route's limit, so leave enough time for the
// provider response, image storage, and the final eBay update.
export const maxDuration = 300;

export default async function ListingsPage() {
  const user = await requireUser();

  // One-time, provider-free repair for Arbitrage listings published before
  // scan research was copied into their listing records.
  await backfillRetainedArbitrageResearchForUser(user.id);

  const [initialProducts, initialListings, connection, suppressions, cachedMarketMetrics, priceProtection, recentOrders, recentActivity] = await Promise.all([
    db.product.findMany({
      where: { userId: user.id },
      include: { listings: { where: { status: { in: ["DRAFT", "ACTIVE"] } } } },
      orderBy: { createdAt: "desc" },
    }),
    db.listing.findMany({
      where: { userId: user.id },
      include: {
        product: {
          select: {
            sku: true,
            title: true,
            imageUrlsJson: true,
            category: true,
            costCents: true,
            shippingCostCents: true,
            supplierStock: true,
            supplierUrl: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    db.ebayConnection.findUnique({ where: { userId: user.id } }),
    db.ebayListingSuppression.findMany({
      where: { userId: user.id },
      select: { ebayListingId: true },
    }),
    db.ebayMarketMetric.findMany({
      where: { userId: user.id },
      select: {
        ebayListingId: true,
        estimatedSales30d: true,
        competitorCount: true,
        averageCompetitorPriceCents: true,
        bestSellingPriceCents: true,
        updatedAt: true,
      },
    }),
    getListingPriceProtection(user.id, user.ebayAdRateBps),
    db.order.findMany({
      where: { userId: user.id, saleDate: { gte: windowStartUtc(30) } },
      include: { amazonPurchaseItem: true },
      orderBy: { saleDate: "desc" },
    }),
    db.mirrorBatch.findMany({
      where: {
        userId: user.id,
        source: { in: ["LISTING_PUBLISH", "LISTING_EDIT", "PRICE_OPTIMIZATION", "PROFIT_PROTECTION", "AI_OPTIMIZATION", "LISTING_END", "LISTING_SYNC"] },
      },
      select: { id: true, source: true, trigger: true, totalCount: true, succeededCount: true, failedCount: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
    }),
  ]);
  const winnerListings = priceProtection.verifiedWinners;
  const profitableSaleLocks = priceProtection.profitableSaleLocks;

  const products = initialProducts;
  const listings = initialListings;
  const ebayConnected = !!connection && connection.status !== "DISCONNECTED";
  const marketMetrics = await getListingMarketMetrics(
    listings.map((listing) => listing.product.sku),
  );
  for (const metric of cachedMarketMetrics) {
    marketMetrics.set(metric.ebayListingId, {
      estimatedSales30d: metric.estimatedSales30d,
      competitorCount: metric.competitorCount,
      averageCompetitorPriceCents: metric.averageCompetitorPriceCents,
      bestSellingPriceCents:
        metric.bestSellingPriceCents ?? metric.averageCompetitorPriceCents,
      updatedAt: metric.updatedAt,
    });
  }
  const cutoff7 = windowStartUtc(7);
  const ordersByListing = new Map<string, Array<(typeof recentOrders)[number] & { actualAmazonCostCents: number | null }>>();
  for (const order of recentOrders) {
    const normalized = { ...order, actualAmazonCostCents: order.amazonPurchaseItem ? actualAmazonCost(order.amazonPurchaseItem) : null };
    ordersByListing.set(order.listingId, [...(ordersByListing.get(order.listingId) ?? []), normalized]);
  }
  const orderPerformance = new Map<string, { units7d: number; units30d: number; profit7dCents: number; profit30dCents: number }>();
  for (const listing of listings) {
    const listingOrders = ordersByListing.get(listing.id) ?? [];
    if (listingOrders.length === 0) continue;
    const totals30 = summarize(listingOrders, user.ebayAdRateBps);
    const totals7 = summarize(listingOrders.filter((order) => order.saleDate >= cutoff7), user.ebayAdRateBps);
    orderPerformance.set(listing.id, {
      units7d: totals7.units,
      units30d: totals30.units,
      profit7dCents: totals7.netCents,
      profit30dCents: totals30.netCents,
    });
  }

  // Render from Sellfinity's retained listing records. Opening this page used
  // to run a full GetMyeBaySelling scan every time, needlessly consuming eBay's
  // legacy Trading API quota and making the whole table unavailable when that
  // quota was exhausted. All app-originated publish, edit, price, end, relist,
  // and Smart Sync operations already update these records after eBay accepts
  // the change, so the database is the reliable read path for normal browsing.
  const ebayItemHost =
    ebayEnvConfig()?.env === "PRODUCTION"
      ? "https://www.ebay.com"
      : "https://sandbox.ebay.com";
  const suppressedEbayIds = new Set(suppressions.map((item) => item.ebayListingId));
  const cachedRemote = retainedEbayListings(listings, suppressedEbayIds, ebayItemHost);
  const localByEbayId = new Map(
    listings.flatMap((listing) => listing.ebayListingId ? [[listing.ebayListingId, listing] as const] : []),
  );
  const ebayRows: EbayRow[] = buildEbayRows(
    cachedRemote,
    listings,
    suppressedEbayIds,
    marketMetrics,
    user.ebaySitewideDiscountBps,
    user.ebayAdRateBps,
    user.targetProfitEnabled ? user.targetProfitCents : null,
    user.pricingStrategy,
  ).map((row) => {
    const local = localByEbayId.get(row.ebayListingId);
    const winner = local ? winnerListings.get(local.id) : null;
    const priceLock = local ? profitableSaleLocks.get(local.id) : null;
    return {
      ...row,
      marketUpdatedAt: (marketMetrics.get(row.ebayListingId)?.updatedAt ?? (local ? marketMetrics.get(local.product.sku)?.updatedAt : null))?.toISOString() ?? null,
      performance: local ? orderPerformance.get(local.id) ?? null : null,
      verifiedWinner: winner ? {
        profitableUnits: winner.profitableUnits,
        profitableSaleDays: winner.profitableSaleDays,
        lastProfitableSaleAt: winner.lastProfitableSaleAt?.toISOString() ?? null,
        protectedUntil: winner.protectedUntil?.toISOString() ?? null,
      } : null,
      priceLocked: !winner && priceLock ? {
        lastProfitableSaleAt: priceLock.lastProfitableSaleAt?.toISOString() ?? null,
        protectedUntil: priceLock.protectedUntil?.toISOString() ?? null,
      } : null,
    };
  });

  const unlisted: UnlistedRow[] = products
    .filter((p) => p.listings.length === 0)
    .map((p) => ({
      productId: p.id,
      sku: p.sku,
      title: p.title,
      imageUrl: parseImageUrls(p.imageUrlsJson)[0] ?? null,
      costCents: p.costCents,
      suggestedPriceCents: p.suggestedPriceCents,
      supplierStock: p.supplierStock,
    }));

  const rows: ListingRow[] = listings.map((l) => {
    const metric =
      (l.ebayListingId ? marketMetrics.get(l.ebayListingId) : null) ??
      marketMetrics.get(l.product.sku) ??
      null;
    const suggestedPlan = listingPricePlan({ amazonCostCents: l.product.costCents, amazonShippingCents: l.product.shippingCostCents, currentEbayPriceCents: l.priceCents, ebayRecommendedPriceCents: metric?.bestSellingPriceCents, averageCompetitorPriceCents: metric?.averageCompetitorPriceCents, sitewideDiscountBps: user.ebaySitewideDiscountBps, adRateBps: user.ebayAdRateBps, targetProfitCents: user.targetProfitEnabled ? user.targetProfitCents : null, pricingStrategy: user.pricingStrategy });

    return {
      id: l.id,
      title: l.title,
      sku: l.product.sku,
      imageUrl: parseImageUrls(l.imageUrlsJson)[0] ?? null,
      priceCents: l.priceCents,
      shippingStrategy: l.shippingStrategy,
      buyerShippingCents: l.buyerShippingCents,
      quantity: l.quantity,
      costCents: l.product.costCents,
      shippingCostCents: l.product.shippingCostCents,
      supplierStock: l.product.supplierStock,
      supplierUrl: l.product.supplierUrl,
      category: l.product.category,
      suggestedPriceCents: suggestedPlan.itemPriceCents,
      suggestedBuyerShippingCents: suggestedPlan.buyerShippingCents,
      status: l.status as "DRAFT" | "ACTIVE" | "ENDED",
      ebayListingId: l.ebayListingId,
      ebayUrl: l.ebayListingId ? `${ebayItemHost}/itm/${l.ebayListingId}` : null,
      publishedAt: l.publishedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
      sourceMatchVerdict: l.sourceMatchVerdict,
      sourceMatchConfidence: l.sourceMatchConfidence,
      sourceMatchReason: l.sourceMatchReason,
      estimatedSales30d: metric?.estimatedSales30d ?? null,
      competitorCount: metric?.competitorCount ?? null,
      averageCompetitorPriceCents: metric?.averageCompetitorPriceCents ?? null,
      ebayRecommendedPriceCents: metric?.bestSellingPriceCents ?? null,
      verifiedWinner: winnerListings.has(l.id),
      priceLocked: !winnerListings.has(l.id) && profitableSaleLocks.has(l.id),
      marketUpdatedAt: metric?.updatedAt?.toISOString() ?? null,
      performance: orderPerformance.get(l.id) ?? null,
    };
  });

  return (
    <>
      <PageHeader
        title="Listings"
        subtitle="Everything live on your eBay account with its Amazon source and margin, plus drafts waiting to publish."
        actions={
          <Badge tone={ebayConnected ? "green" : "amber"}>
            {ebayConnected
              ? `eBay: ${connection?.ebayUsername ?? "connected"}`
              : "eBay not connected"}
          </Badge>
        }
      />
      <div className="relative left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 md:w-[calc(100vw-17rem)]">
        <ListingsView
          unlisted={unlisted}
          listings={rows}
          ebayConnected={ebayConnected}
          ebayRows={ebayRows}
          ebayFetchError={null}
          improveMainImage={user.improveMainImage}
          improveListingContent={user.improveListingContent}
          sitewideDiscountBps={user.ebaySitewideDiscountBps}
          adRateBps={user.ebayAdRateBps}
          recentActivity={recentActivity.map((activity) => ({ ...activity, createdAt: activity.createdAt.toISOString() }))}
        />
      </div>
    </>
  );
}
