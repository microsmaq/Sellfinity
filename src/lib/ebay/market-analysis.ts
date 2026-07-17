import { estimatedSales30d } from "@/lib/arbitrage/demand";
import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";

const NOISE = new Set([
  "new", "brand", "free", "shipping", "fast", "usa", "with", "and", "for",
  "the", "set", "lot", "pack", "piece", "pcs",
]);

export function marketSearchQuery(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !NOISE.has(word))
    .slice(0, 8)
    .join(" ");
}

export type BrowseSummary = {
  itemId?: string;
  title?: string;
  price?: { value?: string };
};

function titleIsComparable(sourceTitle: string, candidateTitle?: string): boolean {
  if (!candidateTitle) return true;
  const source = marketSearchQuery(sourceTitle).split(" ").filter(Boolean);
  if (source.length === 0) return true;
  const candidate = new Set(marketSearchQuery(candidateTitle).split(" ").filter(Boolean));
  const overlap = source.filter((token) => candidate.has(token)).length;
  const required = source.length <= 4
    ? Math.ceil(source.length * 0.75)
    : Math.max(3, Math.ceil(source.length * 0.5));
  return overlap >= required;
}

function medianPrice(items: { priceCents: number }[]): number {
  const prices = items.map((item) => item.priceCents).sort((a, b) => a - b);
  return prices[Math.floor((prices.length - 1) / 2)];
}

export function summarizeBrowseMarket(
  total: number,
  items: BrowseSummary[],
  ownEbayListingId: string,
  sourceTitle = "",
): ListingMarketMetrics | null {
  const ownNumericId = ownEbayListingId.includes("|")
    ? ownEbayListingId.split("|")[1]
    : ownEbayListingId;
  const pricedCandidates = items.flatMap((item) => {
    if (
      !item.itemId ||
      item.itemId === ownEbayListingId ||
      item.itemId.includes(`|${ownNumericId}|`)
    ) return [];
    const priceCents = Math.round(parseFloat(item.price?.value ?? "0") * 100);
    return priceCents > 0
      ? [
          {
            itemId: item.itemId,
            priceCents,
            estimatedSales30d: estimatedSales30d(item.itemId, priceCents),
          },
        ]
      : [];
  });
  const candidates = sourceTitle
    ? pricedCandidates.filter((item) => {
        const original = items.find((candidate) => candidate.itemId === item.itemId);
        return titleIsComparable(sourceTitle, original?.title);
      })
    : pricedCandidates;
  if (candidates.length === 0) return null;
  const median = medianPrice(candidates);
  const priceBand = candidates.filter(
    (item) => item.priceCents >= median * 0.5 && item.priceCents <= median * 1.5,
  );
  const competitors = priceBand.length >= 3 ? priceBand : candidates;
  const prices = competitors.map((item) => item.priceCents).sort((a, b) => a - b);
  const recommendation = prices[Math.floor((prices.length - 1) * 0.25)];
  const estimatedComparableCount = Math.max(
    competitors.length,
    Math.round(
      Math.max(0, total - 1) *
        (competitors.length / Math.max(1, pricedCandidates.length)),
    ),
  );
  return {
    estimatedSales30d: Math.round(
      competitors.reduce(
        (sum, item) => sum + item.estimatedSales30d,
        0,
      ) / competitors.length,
    ),
    competitorCount: estimatedComparableCount,
    averageCompetitorPriceCents: Math.round(
      competitors.reduce((sum, item) => sum + item.priceCents, 0) /
        competitors.length,
    ),
    // Kept under the historical field name for database compatibility. This
    // is now a robust lower-quartile eBay market recommendation.
    bestSellingPriceCents: recommendation,
  };
}
