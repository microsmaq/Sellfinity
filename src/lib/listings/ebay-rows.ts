// Assemble the "Active on eBay" repricer rows: the live eBay listing set
// joined with locally tracked products for margin data.

import { discountedEbayPriceCents } from "@/lib/fees";
import type { RemoteListing } from "@/lib/ebay/client";
import type { EbayRow } from "@/app/(app)/listings/ebay-listings-table";
import type { ListingMarketMetrics } from "./market-metrics";
import { listingPricePlan, trueProfitWithBuyerShippingCents } from "./shipping-strategy";

export type LocalListingFacts = {
  ebayListingId: string | null;
  status: string;
  sourceMatchVerdict: string;
  sourceMatchConfidence: number | null;
  sourceMatchReason: string | null;
  sourceMatchMethod: string | null;
  imageUrlsJson: string;
  publishedAt: Date | null;
  shippingStrategy?: string;
  buyerShippingCents?: number;
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
  pricingStrategy = "AI",
  targetProfitMode = "FIXED",
  targetProfitMinCents = 100,
): EbayRow[] {
  // Callers provide newest rows first. Preserve the first copy instead of
  // letting an older duplicate overwrite it in the Map constructor.
  const byEbayId = new Map<string, LocalListingFacts>();
  for (const listing of local) {
    if (!listing.ebayListingId) continue;
    const retained = byEbayId.get(listing.ebayListingId);
    // A seller decision is authoritative even if a later automatic job left
    // an older duplicate row with a newer timestamp or stale verdict.
    if (!retained || (listing.sourceMatchMethod === "MANUAL" && retained.sourceMatchMethod !== "MANUAL")) {
      byEbayId.set(listing.ebayListingId, listing);
    }
  }

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
        suggestedBuyerShippingCents: null,
        match: null,
        sourceAssessment: null,
        shippingStrategy: null,
        buyerShippingCents: null,
      });
      continue;
    }
    const manuallyVerified = localListing.sourceMatchMethod === "MANUAL";
    if (!manuallyVerified && !["MATCH", "LIKELY"].includes(localListing.sourceMatchVerdict)) {
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
        suggestedBuyerShippingCents: null,
        match: null,
        sourceAssessment: {
          verdict: localListing.sourceMatchVerdict,
          confidence: localListing.sourceMatchConfidence,
          reason: localListing.sourceMatchReason,
          method: localListing.sourceMatchMethod,
          amazonUrl: localListing.product.supplierUrl,
        },
        shippingStrategy: localListing.shippingStrategy ?? "FREE_SHIPPING",
        buyerShippingCents: localListing.buyerShippingCents ?? 0,
      });
      continue;
    }
    const buyerShippingCents = localListing.buyerShippingCents ?? 0;
    const currentProfitCents = trueProfitWithBuyerShippingCents(r.priceCents, buyerShippingCents, localListing.product.costCents, localListing.product.shippingCostCents, sitewideDiscountBps, adRateBps);
    const buyerTotalCents = discountedEbayPriceCents(r.priceCents, sitewideDiscountBps) + buyerShippingCents;
    const market =
      marketMetrics.get(r.ebayListingId) ??
      marketMetrics.get(localListing.product.sku) ??
      null;
    const suggestedPlan = listingPricePlan({ amazonCostCents: localListing.product.costCents, amazonShippingCents: localListing.product.shippingCostCents, currentEbayPriceCents: r.priceCents, ebayRecommendedPriceCents: market?.bestSellingPriceCents, averageCompetitorPriceCents: market?.averageCompetitorPriceCents, sitewideDiscountBps, adRateBps, targetProfitCents, targetProfitMode, targetProfitMinCents, pricingStrategy });
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
      suggestedPriceCents: suggestedPlan.itemPriceCents,
      suggestedBuyerShippingCents: suggestedPlan.buyerShippingCents,
      match: {
        sku: localListing.product.sku,
        amazonPriceCents: localListing.product.costCents,
        shippingCostCents: localListing.product.shippingCostCents,
        amazonUrl: localListing.product.supplierUrl,
        profitCents: currentProfitCents,
        marginPct: buyerTotalCents > 0 ? Math.round(currentProfitCents / buyerTotalCents * 100) : 0,
        unavailable: localListing.product.supplierStock === 0,
      },
      sourceAssessment: {
        verdict: localListing.sourceMatchVerdict,
        confidence: localListing.sourceMatchConfidence,
        reason: localListing.sourceMatchReason,
        method: localListing.sourceMatchMethod,
        amazonUrl: localListing.product.supplierUrl,
      },
      shippingStrategy: localListing.shippingStrategy ?? "FREE_SHIPPING",
      buyerShippingCents: localListing.buyerShippingCents ?? 0,
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
