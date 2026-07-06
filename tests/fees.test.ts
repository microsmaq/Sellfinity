import { describe, expect, it } from "vitest";
import {
  EBAY_FINAL_VALUE_RATE,
  EBAY_PER_ORDER_FEE_CENTS,
  ebayFeeCents,
  estimateMargin,
  grossRevenueCents,
  netProfitCents,
} from "@/lib/fees";

describe("ebayFeeCents", () => {
  it("charges the final value rate on item + shipping, plus the per-order fee", () => {
    const fee = ebayFeeCents({
      quantity: 1,
      salePriceCents: 10000,
      shippingChargedCents: 500,
    });
    expect(fee).toBe(Math.round(10500 * EBAY_FINAL_VALUE_RATE) + EBAY_PER_ORDER_FEE_CENTS);
  });

  it("scales with quantity", () => {
    const one = ebayFeeCents({ quantity: 1, salePriceCents: 2000, shippingChargedCents: 0 });
    const two = ebayFeeCents({ quantity: 2, salePriceCents: 2000, shippingChargedCents: 0 });
    expect(two - EBAY_PER_ORDER_FEE_CENTS).toBe((one - EBAY_PER_ORDER_FEE_CENTS) * 2);
  });
});

describe("netProfitCents", () => {
  it("computes revenue minus fees, shipping, and goods", () => {
    const net = netProfitCents({
      quantity: 1,
      salePriceCents: 2499,
      shippingChargedCents: 0,
      ebayFeeCents: 361,
      shippingCostCents: 450,
      cogsCents: 800,
    });
    expect(net).toBe(2499 - 361 - 450 - 800);
  });

  it("can be negative", () => {
    const net = netProfitCents({
      quantity: 1,
      salePriceCents: 1000,
      shippingChargedCents: 0,
      ebayFeeCents: 163,
      shippingCostCents: 500,
      cogsCents: 900,
    });
    expect(net).toBeLessThan(0);
  });
});

describe("grossRevenueCents", () => {
  it("is unit price times quantity plus shipping charged", () => {
    expect(
      grossRevenueCents({ quantity: 3, salePriceCents: 1500, shippingChargedCents: 250 }),
    ).toBe(4750);
  });
});

describe("estimateMargin", () => {
  it("returns positive margin for a healthy spread", () => {
    const m = estimateMargin(2499, 600, 450);
    expect(m.estimatedProfitCents).toBeGreaterThan(0);
    expect(m.marginPct).toBeGreaterThan(0);
    expect(m.marginPct).toBeLessThan(100);
  });

  it("returns negative margin when cost exceeds market price after fees", () => {
    const m = estimateMargin(1000, 900, 400);
    expect(m.estimatedProfitCents).toBeLessThan(0);
  });

  it("handles zero market price without dividing by zero", () => {
    expect(estimateMargin(0, 100, 100).marginPct).toBe(0);
  });
});
