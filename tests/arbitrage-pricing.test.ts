import { describe, expect, it } from "vitest";
import {
  arbitrageMarketAnchorCents,
  arbitrageSuggestedPriceCents,
} from "@/lib/arbitrage/pricing";
import { discountedEbayPriceCents, estimateMargin } from "@/lib/fees";

describe("arbitrage market pricing", () => {
  it("uses the lowest matched, average, or recommended eBay price", () => {
    expect(arbitrageMarketAnchorCents(1_600, 1_800, 2_000)).toBe(1_600);
    expect(arbitrageSuggestedPriceCents(100, 1_600, 1_800, 2_000)).toBe(1_600);
    expect(arbitrageMarketAnchorCents(1_900, 1_700, 1_800)).toBe(1_700);
    expect(arbitrageSuggestedPriceCents(100, 1_900, 1_700, 1_800)).toBe(1_700);
    expect(arbitrageMarketAnchorCents(1_900, 1_800, 1_600)).toBe(1_600);
    expect(arbitrageSuggestedPriceCents(100, 1_900, 1_800, 1_600)).toBe(1_600);
  });

  it("ignores missing market values", () => {
    expect(arbitrageMarketAnchorCents(1_600, null, 1_500)).toBe(1_500);
    expect(arbitrageSuggestedPriceCents(100, 1_600, null, 1_500)).toBe(1_500);
    expect(arbitrageMarketAnchorCents(1_200, null, 1_500)).toBe(1_200);
    expect(arbitrageSuggestedPriceCents(100, 1_200, null, 1_500)).toBe(1_200);
  });

  it("raises a low market anchor to the hard profitability floor", () => {
    const suggested = arbitrageSuggestedPriceCents(1_000, 1_200, null, 1_500);
    expect(suggested).toBeGreaterThan(1_200);
  });

  it("includes Amazon shipping in the profitability floor", () => {
    const freeShipping = arbitrageSuggestedPriceCents(
      1_000,
      1_500,
      null,
      1_500,
      0,
    );
    const paidShipping = arbitrageSuggestedPriceCents(
      1_000,
      1_500,
      null,
      1_500,
      600,
    );
    expect(paidShipping).toBeGreaterThan(freeShipping);
  });

  it("uses 15% for lower costs and caps higher-cost profit near $7", () => {
    for (const [cost, shipping] of [
      [1_099, 0],
      [2_537, 499],
      [7_990, 9_900],
      [10_800, 2_000],
    ]) {
      const suggested = arbitrageSuggestedPriceCents(
        cost,
        999,
        1_099,
        1_299,
        shipping,
      );
      const margin = estimateMargin(suggested, cost, shipping);
      if (cost + shipping > 3_200) {
        expect(margin.estimatedProfitCents).toBeGreaterThanOrEqual(699);
        expect(margin.estimatedProfitCents).toBeLessThanOrEqual(700);
      } else {
        expect(margin.marginPct).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it("grosses up seller suggestions so the discounted buyer price stays competitive", () => {
    const base = arbitrageSuggestedPriceCents(1_000, 2_000, 1_900, 2_100, 0);
    const discounted = arbitrageSuggestedPriceCents(1_000, 2_000, 1_900, 2_100, 0, 500);
    expect(discounted).toBeGreaterThan(base);
    expect(discountedEbayPriceCents(discounted, 500)).toBe(base);
  });
});
