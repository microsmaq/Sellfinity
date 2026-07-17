import { describe, expect, it } from "vitest";
import { MockArbitrageScanner, asinForSlot } from "@/lib/arbitrage/mock-scanner";
import { amazonStateForDay, productForAsin } from "@/lib/mirror/mock-amazon";
import { ebayFeeCents } from "@/lib/fees";

describe("asinForSlot", () => {
  it("produces valid, deterministic ASINs", () => {
    const asin = asinForSlot(20000, 3);
    expect(asin).toMatch(/^B0[A-Z0-9]{8}$/);
    expect(asin).toBe(asinForSlot(20000, 3));
    expect(asin).not.toBe(asinForSlot(20000, 4));
    expect(asin).not.toBe(asinForSlot(20001, 3));
  });
});

describe("MockArbitrageScanner", () => {
  const scanner = new MockArbitrageScanner(() => 20000);

  it("is deterministic within a day and drifts across days", async () => {
    expect(await scanner.findOpportunities(50)).toEqual(
      await scanner.findOpportunities(50),
    );
    const tomorrow = await new MockArbitrageScanner(() => 20001).findOpportunities(50);
    expect(await scanner.findOpportunities(50)).not.toEqual(tomorrow);
  });

  it("returns the requested count, and a larger scan is a superset of a smaller one", async () => {
    const fifty = await scanner.findOpportunities(50);
    const hundred = await scanner.findOpportunities(100);
    expect(fifty).toHaveLength(50);
    expect(hundred).toHaveLength(100);
    const bigAsins = new Set(hundred.map((o) => o.amazon.asin));
    for (const o of fifty) {
      expect(bigAsins.has(o.amazon.asin)).toBe(true);
    }
  });

  it("only surfaces profitable pairs where Amazon is cheaper, sorted by profit", async () => {
    const opportunities = await scanner.findOpportunities(80);
    expect(opportunities.length).toBeGreaterThan(10);
    let prev = Infinity;
    for (const o of opportunities) {
      expect(o.amazon.priceCents).toBeLessThan(o.ebay.priceCents);
      expect(o.margin.estimatedProfitCents).toBeGreaterThan(0);
      expect(o.margin.estimatedProfitCents).toBeLessThanOrEqual(prev);
      prev = o.margin.estimatedProfitCents;
    }
  });

  it("computes margin net of eBay fees on the eBay sale price", async () => {
    const [o] = await scanner.findOpportunities(10);
    const fee = ebayFeeCents({
      quantity: 1,
      salePriceCents: o.ebay.priceCents,
      shippingChargedCents: 0,
    });
    expect(o.margin.estimatedFeeCents).toBe(fee);
    expect(o.margin.estimatedProfitCents).toBe(
      o.ebay.priceCents - fee - o.amazon.priceCents,
    );
  });

  it("pairs each opportunity with the exact product the mirror sandbox returns", async () => {
    const [o] = await scanner.findOpportunities(10);
    const product = productForAsin(o.amazon.asin);
    expect(o.ebay.title).toBe(product.title);
    const state = amazonStateForDay(o.amazon.asin, 20000);
    expect(state?.costCents).toBe(o.amazon.priceCents);
  });

  it("populates retained demand and competition research for every new item", async () => {
    const opportunities = await scanner.findOpportunities(20);
    for (const opportunity of opportunities) {
      expect(opportunity.market?.estimatedSales30d).toBeGreaterThan(0);
      expect(opportunity.market?.competitorCount).toBeGreaterThan(0);
      expect(opportunity.market?.averageCompetitorPriceCents).toBeGreaterThan(0);
      expect(opportunity.market?.bestSellingPriceCents).toBeGreaterThan(0);
    }
  });
});
