import { describe, expect, it } from "vitest";
import { isSuggestedPriceCandidate } from "@/lib/listings/suggested-price-candidate";

describe("suggested price bulk candidates", () => {
  const base = {
    currentPriceCents: 1_000,
    amazonPriceCents: 500,
    shippingCostCents: 0,
    sitewideDiscountBps: 0,
    adRateBps: 300,
  };

  it("skips listings already at the suggested price", () => {
    expect(isSuggestedPriceCandidate({ ...base, suggestedPriceCents: 1_000 })).toBe(false);
  });

  it("skips missing and unprofitable suggestions", () => {
    expect(isSuggestedPriceCandidate({ ...base, suggestedPriceCents: null })).toBe(false);
    expect(isSuggestedPriceCandidate({ ...base, suggestedPriceCents: 650 })).toBe(false);
  });

  it("queues a different suggested price that clears the profit floor", () => {
    expect(isSuggestedPriceCandidate({ ...base, suggestedPriceCents: 1_199 })).toBe(true);
  });
});
