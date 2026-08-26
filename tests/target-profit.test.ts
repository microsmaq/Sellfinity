import { describe, expect, it } from "vitest";
import { resolveTargetProfitCents } from "@/lib/listings/target-profit";

const settings = {
  targetProfitEnabled: true,
  targetProfitMode: "AI_RANGE",
  targetProfitMinCents: 100,
  targetProfitCents: 700,
  ebaySitewideDiscountBps: 0,
  ebayAdRateBps: 900,
};

describe("adaptive target profit", () => {
  it("uses the minimum when an inexpensive market is tight", () => {
    expect(resolveTargetProfitCents(settings, {
      amazonCostCents: 700,
      ebayRecommendedPriceCents: 1_050,
    })).toBe(100);
  });

  it("uses available competitive profit without exceeding the maximum", () => {
    expect(resolveTargetProfitCents(settings, {
      amazonCostCents: 2_000,
      ebayRecommendedPriceCents: 4_000,
    })).toBeGreaterThan(100);
    expect(resolveTargetProfitCents(settings, {
      amazonCostCents: 2_000,
      ebayRecommendedPriceCents: 10_000,
    })).toBe(700);
  });

  it("preserves fixed targets", () => {
    expect(resolveTargetProfitCents({ ...settings, targetProfitMode: "FIXED", targetProfitCents: 300 }, {
      amazonCostCents: 500,
      ebayRecommendedPriceCents: 900,
    })).toBe(300);
  });
});
