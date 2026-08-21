// Assemble the "Active on eBay" repricer rows: the live eBay listing set
// joined with locally tracked products for margin data.

import { estimateMargin } from "@/lib/fees";
import type { RemoteListing } from "@/lib/ebay/client";
import type { EbayRow } from "@/app/(app)/listings/ebay-listings-table";
import type { ListingMarketMetrics } from "./market-metrics";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";

export type LocalListingFacts = {
  ebayListingId: string | null;
  status: string;
  sourceMatchVerdict: string;
  sourceMatchConfidence: number | null;
  sourceMatchReason: string | null;
  sourceMatchMethod: string | null;
  imageUrlsJson: string;
  publishedAt: Date | null;
  product: {
    sku: string;
    title: string;
    imageUrlsJson: string;
    category: string;
    costCents: number;
    shippingCostCents: number;
    supplierStock: number;
    supplierUrl: string;
  };
};

function firstImage(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as string[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

function sourceFacts(listing: LocalListingFacts) {
  return {
    title: listing.product.title,
    sku: listing.product.sku,
    imageUrl: firstImage(listing.product.imageUrlsJson),
    category: listing.product.category,
    priceCents: listing.product.costCents,
    shippingCostCents: listing.product.shippingCostCents,
    url: listing.product.supplierUrl,
    stock: listing.product.supplierStock,
  };
}

export function buildEbayRows(
  remote: RemoteListing[],
  local: LocalListingFacts[],
  suppressedEbayIds: ReadonlySet<string> = new Set(),
  marketMetrics: ReadonlyMap<string, ListingMarketMetrics> = new Map(),
  sitewideDiscountBps = 0,
  adRateBps = 300,
  targetProfitCents: number | null = null,
): EbayRow[] {
  const byEbayId = new Map(
    local.filter((l) => l.ebayListingId).map((l) => [l.ebayListingId!, l]),
  );

  const rows: EbayRow[] = [];
  const seenEbayIds = new Set<string>();
  for (const r of remote) {
    if (suppressedEbayIds.has(r.ebayListingId)) continue;
    // eBay pagination is not snapshot-stable: when listings change while we
    // fetch successive pages, the boundary can repeat an item. Never render
    // or act on the same live listing twice.
    if (seenEbayIds.has(r.ebayListingId)) continue;
    seenEbayIds.add(r.ebayListingId);

    const localListing = byEbayId.get(r.ebayListingId);
    // A listing positively returned by eBay is live. Explicitly ended items
    // are filtered by the suppression set above; do not let a stale local
    // ENDED status hide a listing that eBay currently confirms is active.

    if (!localListing) {
      rows.push({
        ebayListingId: r.ebayListingId,
        title: r.title,
        priceCents: r.priceCents,
        url: r.url,
        imageUrl: r.imageUrl,
        quantity: r.quantity,
        listingDate: r.listingDate?.toISOString() ?? null,
        source: null,
        market: marketMetrics.get(r.ebayListingId) ?? null,
        suggestedPriceCents: null,
        match: null,
        sourceAssessment: null,
      });
      continue;
    }
    if (!["MATCH", "LIKELY"].includes(localListing.sourceMatchVerdict)) {
      const market =
        marketMetrics.get(r.ebayListingId) ??
        marketMetrics.get(localListing.product.sku) ??
        null;
      rows.push({
        ebayListingId: r.ebayListingId,
        title: r.title,
        priceCents: r.priceCents,
        url: r.url,
        imageUrl: r.imageUrl ?? firstImage(localListing.imageUrlsJson),
        quantity: r.quantity,
        listingDate:
          r.listingDate?.toISOString() ?? localListing.publishedAt?.toISOString() ?? null,
        source: sourceFacts(localListing),
        market,
        suggestedPriceCents: null,
        match: null,
        sourceAssessment: {
          verdict: localListing.sourceMatchVerdict,
          confidence: localListing.sourceMatchConfidence,
          reason: localListing.sourceMatchReason,
          method: localListing.sourceMatchMethod,
          amazonUrl: localListing.product.supplierUrl,
        },
      });
      continue;
    }
    const margin = estimateMargin(
      r.priceCents,
      localListing.product.costCents,
      localListing.product.shippingCostCents,
      sitewideDiscountBps,
      adRateBps,
    );
    const market =
      marketMetrics.get(r.ebayListingId) ??
      marketMetrics.get(localListing.product.sku) ??
      null;
    rows.push({
      ebayListingId: r.ebayListingId,
      title: r.title,
      priceCents: r.priceCents,
      url: r.url,
      imageUrl: r.imageUrl ?? firstImage(localListing.imageUrlsJson),
      quantity: r.quantity,
      listingDate:
        r.listingDate?.toISOString() ?? localListing.publishedAt?.toISOString() ?? null,
      source: sourceFacts(localListing),
      market,
      suggestedPriceCents: arbitrageSuggestedPriceCents(
        localListing.product.costCents,
        r.priceCents,
        market?.bestSellingPriceCents,
        market?.averageCompetitorPriceCents,
        localListing.product.shippingCostCents,
        sitewideDiscountBps,
        adRateBps,
        targetProfitCents,
      ),
      match: {
        sku: localListing.product.sku,
        amazonPriceCents: localListing.product.costCents,
        shippingCostCents: localListing.product.shippingCostCents,
        amazonUrl: localListing.product.supplierUrl,
        profitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        unavailable: localListing.product.supplierStock === 0,
      },
      sourceAssessment: {
        verdict: localListing.sourceMatchVerdict,
        confidence: localListing.sourceMatchConfidence,
        reason: localListing.sourceMatchReason,
        method: localListing.sourceMatchMethod,
        amazonUrl: localListing.product.supplierUrl,
      },
    });
  }

  // Problems first: unavailable, then unprofitable, then unmatched, then
  // thinnest margins.
  return rows.sort((a, b) => {
    const rank = (r: EbayRow) =>
      !r.match ? 2 : r.match.unavailable ? 0 : r.match.profitCents <= 0 ? 1 : 3;
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (a.match?.profitCents ?? 0) - (b.match?.profitCents ?? 0);
  });
}
