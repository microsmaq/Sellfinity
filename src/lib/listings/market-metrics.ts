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
};

/** Aggregate the comparable listings already collected by the arbitrage
 * research pipeline. Demand is the average estimated monthly velocity per
 * competitor; competition and price are based on researched live comps. */
export function aggregateListingMarketMetrics(
  rows: ResearchMetricRow[],
): Map<string, ListingMarketMetrics> {
  const totals = new Map<
    string,
    {
      priceCents: number;
      sales30d: number;
      count: number;
      bestSellingPriceCents: number;
      bestSales30d: number;
    }
  >();
  for (const row of rows) {
    const current = totals.get(row.asin) ?? {
      priceCents: 0,
      sales30d: 0,
      count: 0,
      bestSellingPriceCents: row.ebayPriceCents,
      bestSales30d: row.salesEst,
    };
    current.priceCents += row.ebayPriceCents;
    current.sales30d += row.salesEst;
    current.count++;
    if (row.salesEst > current.bestSales30d) {
      current.bestSales30d = row.salesEst;
      current.bestSellingPriceCents = row.ebayPriceCents;
    }
    totals.set(row.asin, current);
  }

  return new Map(
    [...totals].map(([asin, total]) => [
      asin,
      {
        estimatedSales30d: Math.round(total.sales30d / total.count),
        competitorCount: total.count,
        averageCompetitorPriceCents: Math.round(total.priceCents / total.count),
        bestSellingPriceCents: total.bestSellingPriceCents,
      },
    ]),
  );
}

export async function getListingMarketMetrics(
  asins: string[],
): Promise<Map<string, ListingMarketMetrics>> {
  const uniqueAsins = [...new Set(asins.filter(Boolean))];
  if (uniqueAsins.length === 0) return new Map();
  const rows = await db.arbitrageItem.findMany({
    where: { asin: { in: uniqueAsins } },
    select: { asin: true, ebayPriceCents: true, salesEst: true },
  });
  return aggregateListingMarketMetrics(rows);
}
