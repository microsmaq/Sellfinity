import { describe, expect, it } from "vitest";
import {
  arbitrageMarketAnchorCents,
  arbitrageSuggestedPriceCents,
} from "@/lib/arbitrage/pricing";
import { estimateMargin } from "@/lib/fees";

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

  it("clears the true 15% floor after separate fee rounding", () => {
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
      expect(estimateMargin(suggested, cost, shipping).marginPct).toBeGreaterThanOrEqual(15);
    }
  });
});
