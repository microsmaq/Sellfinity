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
  it("totals revenue, fees, costs, and net", () => {
    const t = summarize([order(), order({ quantity: 2, cogsCents: 1200 })]);
    expect(t.orders).toBe(2);
    expect(t.units).toBe(3);
    expect(t.revenueCents).toBe(2000 + 4000);
    expect(t.feesCents).toBe(590);
    expect(t.cogsCents).toBe(600 + 400 + 1200 + 400);
    expect(t.netCents).toBe(t.revenueCents - t.feesCents - t.cogsCents);
  });

  it("excludes refunded orders from money totals but counts them", () => {
    const t = summarize([order(), order({ status: "REFUNDED" })]);
    expect(t.orders).toBe(1);
    expect(t.refunded).toBe(1);
    expect(t.revenueCents).toBe(2000);
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
