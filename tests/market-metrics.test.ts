import { describe, expect, it } from "vitest";
import { aggregateListingMarketMetrics } from "@/lib/listings/market-metrics";

describe("aggregateListingMarketMetrics", () => {
  it("aggregates demand, competition, and average competitor price by ASIN", () => {
    const metrics = aggregateListingMarketMetrics([
      { asin: "B0ONE", ebayPriceCents: 1999, salesEst: 20 },
      { asin: "B0ONE", ebayPriceCents: 2999, salesEst: 30 },
      { asin: "B0TWO", ebayPriceCents: 4999, salesEst: 10 },
    ]);

    expect(metrics.get("B0ONE")).toEqual({
      estimatedSales30d: 25,
      competitorCount: 2,
      averageCompetitorPriceCents: 2499,
      bestSellingPriceCents: 1999,
    });
    expect(metrics.get("B0TWO")).toEqual({
      estimatedSales30d: 10,
      competitorCount: 1,
      averageCompetitorPriceCents: 4999,
      bestSellingPriceCents: 4999,
    });
  });

  it("returns no metrics when no comparable research exists", () => {
    expect(aggregateListingMarketMetrics([]).size).toBe(0);
  });
});
