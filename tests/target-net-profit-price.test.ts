import { describe, expect, it } from "vitest";
import { targetNetProfitPriceCents, trueProfitCents } from "@/lib/listings/cleanup";

describe("targetNetProfitPriceCents", () => {
  it.each([
    { cost: 678, shipping: 0, target: 700, discount: 0, adRate: 900 },
    { cost: 2400, shipping: 225, target: 1000, discount: 500, adRate: 900 },
    { cost: 7999, shipping: 860, target: 2500, discount: 1000, adRate: 0 },
    { cost: 1299, shipping: 101, target: 0, discount: 0, adRate: 300 },
  ])("returns the minimum cent price reaching the target", ({ cost, shipping, target, discount, adRate }) => {
    const price = targetNetProfitPriceCents(cost, shipping, target, discount, adRate);
    expect(trueProfitCents(price, cost, shipping, discount, adRate)).toBeGreaterThanOrEqual(target);
    if (price > 99) {
      expect(trueProfitCents(price - 1, cost, shipping, discount, adRate)).toBeLessThan(target);
    }
  });
});
