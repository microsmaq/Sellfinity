import { describe, expect, it } from "vitest";
import { assessListingHealth } from "@/lib/listings/health";

function listing(
  priceCents: number,
  amazonPriceCents: number,
  bestSellingPriceCents: number | null,
) {
  return {
    priceCents,
    match: {
      amazonPriceCents,
      shippingCostCents: 0,
      unavailable: false,
    },
    market:
      bestSellingPriceCents === null ? null : { bestSellingPriceCents },
  };
}

describe("assessListingHealth", () => {
  it("requires a verified, available Amazon source", () => {
    expect(
      assessListingHealth({ priceCents: 5000, match: null, market: null }).status,
    ).toBe("SOURCE_ISSUE");
  });

  it("flags negative and insufficient margins before competitiveness", () => {
    expect(assessListingHealth(listing(1000, 1000, 900)).status).toBe(
      "UNPROFITABLE",
    );
    expect(assessListingHealth(listing(2000, 1500, 2500)).status).toBe(
      "THIN_MARGIN",
    );
  });

  it("compares a profitable listing with the best-selling comparable price", () => {
    const competitive = assessListingHealth(listing(3000, 1000, 3200));
    expect(competitive.status).toBe("COMPETITIVE");
    expect(competitive.benchmarkPriceCents).toBe(3200);

    const expensive = assessListingHealth(listing(4000, 1000, 3200));
    expect(expensive.status).toBe("ABOVE_MARKET");
    expect(expensive.priceDifferencePct).toBe(25);
  });
});
