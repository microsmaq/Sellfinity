import { describe, expect, it } from "vitest";
import {
  arbitrageMarketAnchorCents,
  arbitrageSuggestedPriceCents,
} from "@/lib/arbitrage/pricing";

describe("arbitrage market pricing", () => {
  it("uses eBay's recommended price when available", () => {
    expect(arbitrageMarketAnchorCents(1_600, 1_800, 2_000)).toBe(1_800);
    expect(arbitrageSuggestedPriceCents(100, 1_600, 1_800, 2_000)).toBe(1_800);
  });

  it("falls back to the lower matched-eBay or competitor-average price", () => {
    expect(arbitrageMarketAnchorCents(1_600, null, 1_500)).toBe(1_500);
    expect(arbitrageSuggestedPriceCents(100, 1_600, null, 1_500)).toBe(1_500);
    expect(arbitrageMarketAnchorCents(1_200, null, 1_500)).toBe(1_200);
    expect(arbitrageSuggestedPriceCents(100, 1_200, null, 1_500)).toBe(1_200);
  });

  it("raises a low market anchor to the hard profitability floor", () => {
    const suggested = arbitrageSuggestedPriceCents(1_000, 1_200, null, 1_500);
    expect(suggested).toBeGreaterThan(1_200);
  });
});
