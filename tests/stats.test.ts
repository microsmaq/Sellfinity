import { describe, expect, it } from "vitest";
import { dailySeries, perItem, summarize, type OrderFacts } from "@/lib/orders/stats";

function order(overrides: Partial<OrderFacts> = {}): OrderFacts {
  return {
    quantity: 1,
    salePriceCents: 2000,
    shippingChargedCents: 0,
    ebayFeeCents: 295,
    shippingCostCents: 400,
    cogsCents: 600,
    status: "PAID",
    saleDate: new Date("2026-07-01T12:00:00Z"),
    ...overrides,
  };
}

describe("summarize", () => {
  it("uses reconciled Amazon cost instead of the catalog estimate", () => {
    const totals = summarize([{ quantity: 1, salePriceCents: 5000, shippingChargedCents: 0, ebayFeeCents: 700, cogsCents: 2500, shippingCostCents: 0, actualAmazonCostCents: 3100, status: "PAID", saleDate: new Date() }]);
    expect(totals.cogsCents).toBe(3100);
    expect(totals.netCents).toBe(1050);
  });
  it("totals revenue, fees, costs, and net", () => {
    const t = summarize([order(), order({ quantity: 2, cogsCents: 1200 })]);
    expect(t.orders).toBe(2);
    expect(t.units).toBe(3);
    expect(t.revenueCents).toBe(2000 + 4000);
    expect(t.feesCents).toBe(770);
    expect(t.cogsCents).toBe(600 + 400 + 1200 + 400);
    expect(t.netCents).toBe(t.revenueCents - t.feesCents - t.cogsCents);
  });

  it("deducts the configured ad rate from reported profit", () => {
    const lowAds = summarize([order()], 300);
    const highAds = summarize([order()], 900);
    expect(lowAds.netCents - highAds.netCents).toBe(120);
    expect(highAds.feesCents - lowAds.feesCents).toBe(120);
  });

  it("uses finalized eBay earnings and ignores the estimated ad rate", () => {
    const finalized = order({
      ebayFinancialsSource: "ACTUAL",
      ebayGrossAmountCents: 2000,
      ebayOrderEarningsCents: 1500,
      ebayTransactionFeeCents: 300,
      ebayAdvertisingFeeCents: 200,
      ebayOtherFeeCents: 0,
      ebayShippingLabelCents: 0,
      ebayRefundCents: 0,
      actualAmazonCostCents: 900,
    });
    const lowRate = summarize([finalized], 100);
    const highRate = summarize([finalized], 1500);
    expect(lowRate.netCents).toBe(600);
    expect(highRate.netCents).toBe(600);
    expect(lowRate.feesCents).toBe(500);
    expect(lowRate.actualEbayOrders).toBe(1);
    expect(lowRate.estimatedEbayOrders).toBe(0);
  });

  it("excludes refunded orders from money totals but counts them", () => {
    const t = summarize([order(), order({ status: "REFUNDED" })]);
    expect(t.orders).toBe(1);
    expect(t.refunded).toBe(1);
    expect(t.revenueCents).toBe(2000);
  });

  it("accounts for a refund once eBay supplies finalized earnings", () => {
    const totals = summarize([order({
      status: "REFUNDED",
      ebayFinancialsSource: "ACTUAL",
      ebayGrossAmountCents: 2000,
      ebayOrderEarningsCents: -100,
      ebayTransactionFeeCents: 0,
      ebayAdvertisingFeeCents: 0,
      ebayOtherFeeCents: 0,
      ebayShippingLabelCents: 0,
      ebayRefundCents: 2100,
      actualAmazonCostCents: 1000,
    })]);
    expect(totals.refunded).toBe(1);
    expect(totals.netCents).toBe(-1100);
  });

  it("excludes cancelled orders from profit and daily sales", () => {
    const cancelled = order({ sourcingStatus: "CANCELLED" });
    const totals = summarize([order(), cancelled]);
    const series = dailySeries([cancelled], 7, new Date("2026-07-04T18:00:00Z"));
    expect(totals.orders).toBe(1);
    expect(totals.revenueCents).toBe(2000);
    expect(totals.refunded).toBe(0);
    expect(series.every((point) => point.revenueCents === 0)).toBe(true);
  });

  it("handles the empty case", () => {
    const t = summarize([]);
    expect(t.netCents).toBe(0);
    expect(t.orders).toBe(0);
  });
});

describe("dailySeries", () => {
  it("zero-fills every day and buckets orders by sale date", () => {
    const now = new Date("2026-07-04T18:00:00Z");
    const series = dailySeries(
      [order(), order({ saleDate: new Date("2026-07-04T01:00:00Z") })],
      7,
      now,
    );
    expect(series).toHaveLength(7);
    expect(series[series.length - 1].date).toBe("2026-07-04");
    const july1 = series.find((p) => p.date === "2026-07-01")!;
    expect(july1.revenueCents).toBe(2000);
    expect(series.filter((p) => p.revenueCents === 0)).toHaveLength(5);
  });

  it("ignores orders outside the window", () => {
    const now = new Date("2026-07-04T18:00:00Z");
    const series = dailySeries(
      [order({ saleDate: new Date("2026-05-01T00:00:00Z") })],
      7,
      now,
    );
    expect(series.every((p) => p.revenueCents === 0)).toBe(true);
  });
});

describe("perItem", () => {
  it("groups by product and sorts by net profit", () => {
    const rows = perItem([
      { ...order(), productId: "a", title: "A", sku: "A-1" },
      { ...order({ salePriceCents: 9000 }), productId: "b", title: "B", sku: "B-1" },
      { ...order(), productId: "a", title: "A", sku: "A-1" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].productId).toBe("b");
    expect(rows[1].units).toBe(2);
  });
});
