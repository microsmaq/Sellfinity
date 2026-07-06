import { describe, expect, it } from "vitest";
import { netProfitCents, ebayFeeCents } from "@/lib/fees";
import { scoreAndRank, scoreCandidate, suggestPriceCents } from "@/lib/sourcing/scoring";
import type { SourcingCandidate } from "@/lib/sourcing/provider";

function candidate(overrides: Partial<SourcingCandidate> = {}): SourcingCandidate {
  return {
    supplierName: "Test",
    supplierProductId: "T-1",
    supplierUrl: "https://example.com",
    title: "Test product",
    description: "Test",
    category: "Test",
    imageUrls: [],
    costCents: 600,
    stock: 100,
    marketPriceCents: 2499,
    shippingCostCents: 450,
    salesPerWeek: 30,
    competitorCount: 20,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("scores within 0-100", () => {
    const s = scoreCandidate(candidate());
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it("caps unprofitable products at a floor score regardless of demand", () => {
    const s = scoreCandidate(
      candidate({ costCents: 2400, salesPerWeek: 100, competitorCount: 1 }),
    );
    expect(s.margin.estimatedProfitCents).toBeLessThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(10);
  });

  it("rewards higher demand, all else equal", () => {
    const low = scoreCandidate(candidate({ salesPerWeek: 5 }));
    const high = scoreCandidate(candidate({ salesPerWeek: 55 }));
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("penalizes competition, all else equal", () => {
    const crowded = scoreCandidate(candidate({ competitorCount: 60 }));
    const open = scoreCandidate(candidate({ competitorCount: 5 }));
    expect(open.score).toBeGreaterThan(crowded.score);
  });
});

describe("scoreAndRank", () => {
  it("sorts by score descending", () => {
    const ranked = scoreAndRank([
      candidate({ supplierProductId: "bad", costCents: 2400 }),
      candidate({ supplierProductId: "good", costCents: 400, salesPerWeek: 55 }),
    ]);
    expect(ranked[0].supplierProductId).toBe("good");
  });
});

describe("suggestPriceCents", () => {
  it("undercuts market with charm pricing when margin is healthy", () => {
    const price = suggestPriceCents({
      marketPriceCents: 2499,
      costCents: 600,
      shippingCostCents: 450,
    });
    expect(price).toBeLessThan(2499);
    expect(price % 100).toBe(99);
  });

  it("never suggests a loss-making price", () => {
    // Even for terrible spreads, selling at the suggested price nets >= ~$1.
    for (const costCents of [500, 1500, 2500, 5000]) {
      const price = suggestPriceCents({
        marketPriceCents: 1000,
        costCents,
        shippingCostCents: 600,
      });
      const net = netProfitCents({
        quantity: 1,
        salePriceCents: price,
        shippingChargedCents: 0,
        ebayFeeCents: ebayFeeCents({
          quantity: 1,
          salePriceCents: price,
          shippingChargedCents: 0,
        }),
        shippingCostCents: 600,
        cogsCents: costCents,
      });
      expect(net).toBeGreaterThanOrEqual(99);
    }
  });
});
