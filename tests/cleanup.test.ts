import { describe, expect, it } from "vitest";
import {
  AD_RATE,
  END_MARGIN,
  TARGET_MARGIN,
  TARGET_PROFIT_CENTS,
  charmCeilCents,
  classifyListing,
  targetPriceCents,
  trueProfitCents,
} from "@/lib/listings/cleanup";
import { EBAY_FINAL_VALUE_RATE, EBAY_PER_ORDER_FEE_CENTS } from "@/lib/fees";

describe("trueProfitCents", () => {
  it("subtracts FVF, ad rate, per-order fee, cost, and shipping", () => {
    const profit = trueProfitCents(2000, 800, 100);
    const expected =
      2000 -
      Math.round(2000 * (EBAY_FINAL_VALUE_RATE + AD_RATE)) -
      EBAY_PER_ORDER_FEE_CENTS -
      800 -
      100;
    expect(profit).toBe(expected);
  });
});

describe("charmCeilCents", () => {
  it("rounds up to the next .99, never down", () => {
    expect(charmCeilCents(1234)).toBe(1299);
    expect(charmCeilCents(1299)).toBe(1299);
    expect(charmCeilCents(1300)).toBe(1399);
    expect(charmCeilCents(1)).toBe(99);
  });
});

describe("targetPriceCents", () => {
  it("reaches at least one target at the returned price, and the price is minimal-ish", () => {
    for (const cost of [500, 860, 1500, 4000, 9000]) {
      const price = targetPriceCents(cost, 0);
      const profit = trueProfitCents(price, cost, 0);
      const margin = profit / price;
      // At the target price, one of the two goals is met…
      expect(
        margin >= TARGET_MARGIN - 0.005 || profit >= TARGET_PROFIT_CENTS,
      ).toBe(true);
      // …and a dollar cheaper would meet neither (minimality, modulo charm).
      const cheaper = price - 100;
      const cheaperProfit = trueProfitCents(cheaper, cost, 0);
      expect(
        cheaperProfit / cheaper >= TARGET_MARGIN ||
          cheaperProfit >= TARGET_PROFIT_CENTS,
      ).toBe(false);
    }
  });

  it("picks the margin target for cheap items and the profit target for pricey ones", () => {
    // Cheap item: 30% margin needs a lower price than $7 profit.
    const cheap = targetPriceCents(500, 0);
    expect(trueProfitCents(cheap, 500, 0)).toBeLessThan(TARGET_PROFIT_CENTS);
    // Expensive item: $7 profit comes before 30% margin.
    const pricey = targetPriceCents(9000, 0);
    expect(trueProfitCents(pricey, 9000, 0) / pricey).toBeLessThan(TARGET_MARGIN);
  });

  it("accounts for shipping cost", () => {
    expect(targetPriceCents(1000, 500)).toBeGreaterThan(targetPriceCents(1000, 0));
  });
});

describe("classifyListing", () => {
  it("leaves healthy listings alone (margin target)", () => {
    // $20 price, $8 cost → profit ≈ 20*0.8375-0.30-8 = 8.45 ≥ $7
    expect(classifyListing(2000, 800, 0)).toEqual({ action: "ok" });
  });

  it("leaves high-ticket listings alone once profit ≥ $7", () => {
    // $100 price, $85 cost → profit ≈ 83.45-85 < 0… pick numbers: $100, $75 → 83.45-75.3=8.15 ≥ 7 but margin 8% < 30%
    const decision = classifyListing(10000, 7500, 0);
    expect(decision).toEqual({ action: "ok" });
  });

  it("reprices listings below both targets but above the end threshold", () => {
    // $10 price, $9 cost → profit = 8.375-0.30-9 = -0.93 → margin -9.3%
    const decision = classifyListing(1000, 900, 0);
    expect(decision.action).toBe("reprice");
    if (decision.action === "reprice") {
      expect(decision.newPriceCents).toBeGreaterThan(1000);
      expect(decision.newPriceCents % 100).toBe(99);
      const profit = trueProfitCents(decision.newPriceCents, 900, 0);
      expect(
        profit / decision.newPriceCents >= TARGET_MARGIN - 0.005 ||
          profit >= TARGET_PROFIT_CENTS,
      ).toBe(true);
    }
  });

  it("ends listings at or beyond -30% margin", () => {
    // $10 price, $13 cost → profit = 8.375-0.3-13 = -4.93 → margin -49%
    expect(classifyListing(1000, 1300, 0)).toEqual({ action: "end" });
    expect(END_MARGIN).toBe(-0.3);
  });

  it("boundary: just above the end threshold gets repriced, not ended", () => {
    // margin ≈ -25%: price $10, cost ~ $11.1 → profit = 8.375-0.3-11.1 = -3.03 (-30.3%) too low; use cost $10.5 → -2.43 (-24.3%)
    const decision = classifyListing(1000, 1050, 0);
    expect(decision.action).toBe("reprice");
  });
});
