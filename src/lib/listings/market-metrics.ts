import { db } from "@/lib/db";

export type ListingMarketMetrics = {
  estimatedSales30d: number;
  competitorCount: number;
  averageCompetitorPriceCents: number;
  bestSellingPriceCents: number;
};

type ResearchMetricRow = {
  asin: string;
  ebayPriceCents: number;
  salesEst: number;
  competitorCount?: number | null;
  avgCompPriceCents?: number | null;
  bestSellingPriceCents?: number | null;
};

/** Aggregate the comparable listings already collected by the arbitrage
 * research pipeline. Demand is the average estimated monthly velocity per
 * competitor; competition and price are based on researched live comps. */
export function aggregateListingMarketMetrics(
  rows: ResearchMetricRow[],
): Map<string, ListingMarketMetrics> {
  const totals = new Map<string, ResearchMetricRow[]>();
  for (const row of rows) {
    totals.set(row.asin, [...(totals.get(row.asin) ?? []), row]);
  }

  return new Map(
    [...totals].map(([asin, asinRows]) => {
      const sortedPrices = asinRows
        .map((row) => row.ebayPriceCents)
        .sort((a, b) => a - b);
      const researchedCompetition = asinRows
        .map((row) => row.competitorCount)
        .filter((value): value is number => value !== null && value !== undefined);
      const researchedAverages = asinRows
        .map((row) => row.avgCompPriceCents)
        .filter((value): value is number => value !== null && value !== undefined);
      const researchedRecommendations = asinRows
        .map((row) => row.bestSellingPriceCents)
        .filter((value): value is number => value !== null && value !== undefined)
        .sort((a, b) => a - b);
      return [
        asin,
        {
          estimatedSales30d: Math.round(
            asinRows.reduce((sum, row) => sum + row.salesEst, 0) / asinRows.length,
          ),
          competitorCount: Math.max(
            asinRows.length,
            ...researchedCompetition,
          ),
          averageCompetitorPriceCents: researchedAverages.length
            ? Math.round(
                researchedAverages.reduce((sum, value) => sum + value, 0) /
                  researchedAverages.length,
              )
            : Math.round(
                asinRows.reduce((sum, row) => sum + row.ebayPriceCents, 0) /
                  asinRows.length,
              ),
          bestSellingPriceCents:
            researchedRecommendations[0] ??
            sortedPrices[Math.floor((sortedPrices.length - 1) * 0.25)],
        },
      ];
    }),
  );
}

export async function getListingMarketMetrics(
  asins: string[],
): Promise<Map<string, ListingMarketMetrics>> {
  const uniqueAsins = [...new Set(asins.filter(Boolean))];
  if (uniqueAsins.length === 0) return new Map();
  const rows = await db.arbitrageItem.findMany({
    where: { asin: { in: uniqueAsins } },
    select: {
      asin: true,
      ebayPriceCents: true,
      salesEst: true,
      competitorCount: true,
      avgCompPriceCents: true,
      bestSellingPriceCents: true,
    },
  });
  return aggregateListingMarketMetrics(rows);
}
