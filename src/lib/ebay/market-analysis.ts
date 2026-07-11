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

export type BrowseSummary = { itemId?: string; price?: { value?: string } };

export function summarizeBrowseMarket(
  total: number,
  items: BrowseSummary[],
  ownEbayListingId: string,
): ListingMarketMetrics | null {
  const competitors = items.flatMap((item) => {
    if (!item.itemId || item.itemId.includes(`|${ownEbayListingId}|`)) return [];
    const priceCents = Math.round(parseFloat(item.price?.value ?? "0") * 100);
    return priceCents > 0 ? [{ itemId: item.itemId, priceCents }] : [];
  });
  if (competitors.length === 0) return null;
  return {
    estimatedSales30d: Math.round(
      competitors.reduce(
        (sum, item) => sum + estimatedSales30d(item.itemId, item.priceCents),
        0,
      ) / competitors.length,
    ),
    competitorCount: Math.max(competitors.length, total - 1),
    averageCompetitorPriceCents: Math.round(
      competitors.reduce((sum, item) => sum + item.priceCents, 0) /
        competitors.length,
    ),
  };
}
