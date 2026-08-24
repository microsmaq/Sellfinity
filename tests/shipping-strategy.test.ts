import { describe, expect, it } from "vitest";
import {
  listingPricePlan,
  MAX_BUYER_SHIPPING_CENTS,
  trueProfitWithBuyerShippingCents,
} from "@/lib/listings/shipping-strategy";

const base = {
  amazonCostCents: 2_000,
  amazonShippingCents: 0,
  sitewideDiscountBps: 0,
  adRateBps: 900,
  targetProfitCents: 700,
};

describe("listingPricePlan", () => {
  it("keeps free shipping in AI mode when the profitable price is competitive", () => {
    const plan = listingPricePlan({ ...base, ebayRecommendedPriceCents: 5_000, pricingStrategy: "AI" });
    expect(plan.shippingStrategy).toBe("FREE_SHIPPING");
    expect(plan.buyerShippingCents).toBe(0);
    expect(plan.modeledProfitCents).toBeGreaterThanOrEqual(700);
  });

  it("uses capped buyer-paid shipping when matching the market needs help", () => {
    const plan = listingPricePlan({ ...base, ebayRecommendedPriceCents: 2_500, pricingStrategy: "AI" });
    expect(plan.shippingStrategy).toBe("BUYER_PAID_SHIPPING");
    expect(plan.buyerShippingCents).toBeGreaterThan(0);
    expect(plan.buyerShippingCents).toBeLessThanOrEqual(MAX_BUYER_SHIPPING_CENTS);
    expect(plan.modeledProfitCents).toBeGreaterThanOrEqual(700);
  });

  it("honors explicit free and buyer-paid choices", () => {
    const free = listingPricePlan({ ...base, ebayRecommendedPriceCents: 2_500, pricingStrategy: "FREE_SHIPPING" });
    const paid = listingPricePlan({ ...base, ebayRecommendedPriceCents: 5_000, pricingStrategy: "BUYER_PAID_SHIPPING" });
    expect(free.buyerShippingCents).toBe(0);
    expect(paid.buyerShippingCents).toBe(700);
    expect(paid.itemPriceCents).toBeLessThan(free.itemPriceCents);
    expect(paid.modeledProfitCents).toBeGreaterThanOrEqual(700);
  });

  it("includes the promotion discount and advertising rate in the target", () => {
    for (const pricingStrategy of ["FREE_SHIPPING", "BUYER_PAID_SHIPPING", "AI"] as const) {
      const plan = listingPricePlan({
        ...base,
        ebayRecommendedPriceCents: 2_700,
        sitewideDiscountBps: 1_000,
        adRateBps: 900,
        targetProfitCents: 1_000,
        pricingStrategy,
      });
      expect(trueProfitWithBuyerShippingCents(
        plan.itemPriceCents,
        plan.buyerShippingCents,
        base.amazonCostCents,
        base.amazonShippingCents,
        1_000,
        900,
      )).toBeGreaterThanOrEqual(1_000);
    }
  });
});

describe("trueProfitWithBuyerShippingCents", () => {
  it("charges percentage fees on buyer-paid shipping", () => {
    const withoutShipping = trueProfitWithBuyerShippingCents(3_000, 0, 2_000, 0, 0, 900);
    const withShipping = trueProfitWithBuyerShippingCents(3_000, 700, 2_000, 0, 0, 900);
    expect(withShipping - withoutShipping).toBeGreaterThan(0);
    expect(withShipping - withoutShipping).toBeLessThan(700);
  });
});

