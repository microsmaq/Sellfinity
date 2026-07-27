import { aiSuggestedListingPriceCents } from "@/lib/listings/cleanup";

function positive(value?: number | null): number | null {
  return value !== null && value !== undefined && value > 0 ? value : null;
}

/**
 * eBay's recommendation is the preferred market anchor. When eBay does not
 * provide one, use the lower observable price between the matched eBay item
 * and the competitor average, as requested by the catalog administrator.
 */
export function arbitrageMarketAnchorCents(
  ebayPriceCents: number,
  ebayRecommendedPriceCents?: number | null,
  averageCompetitorPriceCents?: number | null,
): number {
  const recommended = positive(ebayRecommendedPriceCents);
  if (recommended) return recommended;
  const fallbackPrices = [
    positive(ebayPriceCents),
    positive(averageCompetitorPriceCents),
  ].filter((value): value is number => value !== null);
  return fallbackPrices.length > 0 ? Math.min(...fallbackPrices) : ebayPriceCents;
}

export function arbitrageSuggestedPriceCents(
  amazonPriceCents: number,
  ebayPriceCents: number,
  ebayRecommendedPriceCents?: number | null,
  averageCompetitorPriceCents?: number | null,
  shippingCostCents = 0,
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
  );
}
