import { aiSuggestedListingPriceCents } from "@/lib/listings/cleanup";

function positive(value?: number | null): number | null {
  return value !== null && value !== undefined && value > 0 ? value : null;
}

/**
 * Use the lowest valid observable eBay market price so the recommendation
 * remains competitive. The downstream pricing function still raises this
 * anchor when necessary to preserve the hard profitability floor.
 */
export function arbitrageMarketAnchorCents(
  ebayPriceCents: number,
  ebayRecommendedPriceCents?: number | null,
  averageCompetitorPriceCents?: number | null,
): number {
  const marketPrices = [
    positive(ebayPriceCents),
    positive(averageCompetitorPriceCents),
    positive(ebayRecommendedPriceCents),
  ].filter((value): value is number => value !== null);
  return marketPrices.length > 0 ? Math.min(...marketPrices) : ebayPriceCents;
}

export function arbitrageSuggestedPriceCents(
  amazonPriceCents: number,
  ebayPriceCents: number,
  ebayRecommendedPriceCents?: number | null,
  averageCompetitorPriceCents?: number | null,
  shippingCostCents = 0,
  sitewideDiscountBps = 0,
  adRateBps = 300,
): number {
  const anchor = arbitrageMarketAnchorCents(
    ebayPriceCents,
    ebayRecommendedPriceCents,
    averageCompetitorPriceCents,
  );
  return aiSuggestedListingPriceCents(
    amazonPriceCents,
    shippingCostCents,
    anchor,
    positive(averageCompetitorPriceCents) ?? positive(ebayPriceCents),
    sitewideDiscountBps,
    adRateBps,
  );
}
