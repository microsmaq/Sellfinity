import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  opportunity: vi.fn(),
  opportunityUpdate: vi.fn(),
  listingFind: vi.fn(),
  listingUpdateMany: vi.fn(),
  metricUpsert: vi.fn(),
  transaction: vi.fn(),
  research: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    arbitrageItem: {
      findUnique: mocks.opportunity,
      update: mocks.opportunityUpdate,
      findMany: vi.fn(),
    },
    listing: {
      findFirst: mocks.listingFind,
      findMany: vi.fn(),
      updateMany: mocks.listingUpdateMany,
      update: vi.fn(),
    },
    ebayMarketMetric: {
      upsert: mocks.metricUpsert,
      findMany: vi.fn(),
      create: vi.fn(),
    },
    mirrorBatchItem: { findMany: vi.fn() },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/ebay/market", () => ({ researchEbayMarket: mocks.research }));

import {
  attachArbitrageResearchToListing,
  retainPublishedArbitrageResearch,
} from "@/lib/arbitrage/publish-handoff";

const retainedOpportunity = {
  ebayItemId: "SOURCE-1",
  ebayTitle: "Exact product",
  ebayPriceCents: 3999,
  salesEst: 32,
  competitorCount: 14,
  avgCompPriceCents: 4199,
  bestSellingPriceCents: 3899,
  matchVerdict: "MATCH",
  matchConfidence: 98,
  matchReason: "Exact variant",
  matchMethod: "AI",
  matchCheckedAt: new Date("2026-07-16T12:00:00.000Z"),
};

describe("Arbitrage publishing research handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.opportunityUpdate.mockResolvedValue({});
    mocks.metricUpsert.mockResolvedValue({});
    mocks.transaction.mockResolvedValue([]);
  });

  it("copies verified match confidence onto the mirrored listing", async () => {
    mocks.opportunity.mockResolvedValue(retainedOpportunity);
    await attachArbitrageResearchToListing("user-1", "listing-1", "SOURCE-1");
    expect(mocks.listingUpdateMany).toHaveBeenCalledWith({
      where: { id: "listing-1", userId: "user-1" },
      data: expect.objectContaining({
        sourceMatchVerdict: "MATCH",
        sourceMatchConfidence: 98,
        sourceMatchReason: "Exact variant",
      }),
    });
  });

  it("stores discovery demand and competition under the new eBay listing ID", async () => {
    mocks.listingFind.mockResolvedValue({ title: "Exact product" });
    mocks.opportunity.mockResolvedValue(retainedOpportunity);
    await retainPublishedArbitrageResearch(
      "user-1",
      "listing-1",
      "NEW-EBAY-ID",
      "SOURCE-1",
    );
    expect(mocks.research).not.toHaveBeenCalled();
    expect(mocks.metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          ebayListingId: "NEW-EBAY-ID",
          estimatedSales30d: 32,
          competitorCount: 14,
          averageCompetitorPriceCents: 4199,
          bestSellingPriceCents: 3899,
        }),
      }),
    );
  });
});
