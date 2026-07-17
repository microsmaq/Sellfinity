import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { buildEbayRows } from "@/lib/listings/ebay-rows";
import { getListingMarketMetrics } from "@/lib/listings/market-metrics";
import { parseImageUrls } from "@/lib/types";
import { PageHeader, Badge } from "@/components/ui";
import { ListingsView, type ListingRow, type UnlistedRow } from "./listings-view";
import type { EbayRow } from "./ebay-listings-table";
import { backfillRetainedArbitrageResearchForUser } from "@/lib/arbitrage/publish-handoff";

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

  const [products, listings, connection, suppressions, cachedMarketMetrics] = await Promise.all([
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
      },
    }),
  ]);

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
    });
  }

  // The seller's live eBay listings, joined to tracked products for margin.
  let ebayRows: EbayRow[] = [];
  let ebayFetchError: string | null = null;
  if (ebayConnected) {
    try {
      const client = await getEbayClientForUser(user.id);
      const remote = await client.getSellerListings(user.id);
      // Self-heal: a tracked ACTIVE listing that eBay no longer reports was
      // ended outside the app — record that. (Only for listings older than a
      // day: eBay's list can lag freshly published items.)
      const remoteIds = remote.map((r) => r.ebayListingId);
      await db.listing.updateMany({
        where: {
          userId: user.id,
          status: "ACTIVE",
          ebayListingId: { not: null, notIn: remoteIds },
          publishedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        data: { status: "ENDED", endedAt: new Date() },
      });
      ebayRows = buildEbayRows(
        remote,
        listings,
        new Set(suppressions.map((item) => item.ebayListingId)),
        marketMetrics,
      );
    } catch (e) {
      ebayFetchError = e instanceof Error ? e.message.slice(0, 200) : "eBay lookup failed";
    }
  }

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

  const ebayItemHost =
    ebayEnvConfig()?.env === "PRODUCTION"
      ? "https://www.ebay.com"
      : "https://sandbox.ebay.com";
  const rows: ListingRow[] = listings.map((l) => ({
    id: l.id,
    title: l.title,
    sku: l.product.sku,
    imageUrl: parseImageUrls(l.imageUrlsJson)[0] ?? null,
    priceCents: l.priceCents,
    quantity: l.quantity,
    costCents: l.product.costCents,
    status: l.status as "DRAFT" | "ACTIVE" | "ENDED",
    ebayListingId: l.ebayListingId,
    ebayUrl: l.ebayListingId ? `${ebayItemHost}/itm/${l.ebayListingId}` : null,
    publishedAt: l.publishedAt?.toISOString() ?? null,
  }));

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
      <ListingsView
        unlisted={unlisted}
        listings={rows}
        ebayConnected={ebayConnected}
        ebayRows={ebayRows}
        ebayFetchError={ebayFetchError}
        improveMainImage={user.improveMainImage}
        improveListingContent={user.improveListingContent}
      />
    </>
  );
}
