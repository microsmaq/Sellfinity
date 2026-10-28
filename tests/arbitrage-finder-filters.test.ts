import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ catalog: vi.fn(), count: vi.fn(), products: vi.fn(), productCount: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  hiddenArbitrageItem: { findMany: vi.fn().mockResolvedValue([]) },
  user: { findUnique: vi.fn().mockResolvedValue({ ebaySitewideDiscountBps: 0, ebayAdRateBps: 300 }) },
  adminArbitrageProduct: { findMany: m.catalog, count: m.count },
  product: { findMany: m.products, count: m.productCount },
  arbitrageItem: { findMany: vi.fn().mockResolvedValue([]) },
  userArbitrageMatchDecision: { findMany: vi.fn().mockResolvedValue([]) },
} }));
vi.mock("@/lib/arbitrage/admin-catalog", () => ({ syncAdminCatalogFromOpportunities: vi.fn() }));
vi.mock("@/lib/ebay/oauth", () => ({ ebayEnvConfig: () => null }));
import { listArbitragePage } from "@/lib/arbitrage/store";

const date = new Date("2026-01-01T00:00:00Z");
const items = ["A", "B", "C"].map((asin, index) => ({ asin, updatedAt: date, createdAt: date, amazonPriceCents: 500, amazonShippingCents: index * 50, ebayPriceCents: 1500 + index * 100, ebayRecommendedPriceCents: 1500, averageCompetitorPriceCents: 1500, ebayItemId: asin, amazonTitle: asin, ebayTitle: asin, category: "Home", amazonUrl: "https://amazon.com", ebayUrl: "https://ebay.com", amazonImageUrl: null, ebayImageUrl: null, estimatedSales30d: index ? 20 : null, competitorCount: 2, isAmazonBestSeller: true, lastResearchedAt: date, matchVerdict: "MATCH", matchConfidence: 100, matchReason: null }));
const base = { page: 1, pageSize: 25, sortKey: "usersListed" as const, sortDesc: true, category: "all", minMarginPct: 0, query: "" };

beforeEach(() => {
  m.count.mockResolvedValue(3);
  m.productCount.mockResolvedValue(0);
  m.products.mockImplementation(async (args) => args.where.userId ? [] : [{ sku: "B", userId: "1" }, { sku: "B", userId: "2" }, { sku: "A", userId: "1" }]);
  m.catalog.mockImplementation(async (args) => {
    if (args.distinct) return [{ category: "Home" }];
    if (args.select?.asin && !args.select?.amazonPriceCents) return items.map(({ asin }) => ({ asin }));
    if (args.select && !args.select.asin) return [];
    if (args.where?.asin?.in) return items.filter((item) => args.where.asin.in.includes(item.asin));
    return items;
  });
});

describe("arbitrage finder filters", () => {
  it("filters and sorts distinct active users before pagination", async () => {
    const result = await listArbitragePage("seller", { ...base, minUsers: 1 });
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => [row.asin, row.usersListed])).toEqual([["B", 2], ["A", 1]]);
    expect(result.rows[1].ebaySales30d).toBeNull();
  });
  it("combines qualified and text search with sales and price filters", async () => {
    await listArbitragePage("seller", { ...base, qualifiedOnly: true, query: "tea", minSales: 10, minEbayPriceCents: 500, maxEbayPriceCents: 2000 });
    const where = m.count.mock.calls.at(-1)![0].where;
    expect(where.AND[0].OR).toHaveLength(2);
    expect(where.OR[0].asin.contains).toBe("tea");
    expect(where.estimatedSales30d.gte).toBe(10);
    expect(where.ebayPriceCents).toEqual({ gte: 500, lte: 2000 });
  });
  it("applies price assessment across all candidates before paging", async () => {
    const all = await listArbitragePage("seller", { ...base, sortKey: "priceAssessment" });
    const assessment = all.rows[0];
    const { assessPriceCompetitiveness } = await import("@/lib/arbitrage/price-competitiveness");
    const label = assessPriceCompetitiveness(assessment.suggestedListingPriceCents, assessment.ebayPriceCents, assessment.avgCompPriceCents, assessment.ebayRecommendedPriceCents, null, 0).label;
    const filtered = await listArbitragePage("seller", { ...base, priceAssessment: label });
    expect(filtered.total).toBeGreaterThan(0);
    for (const row of filtered.rows) expect(assessPriceCompetitiveness(row.suggestedListingPriceCents, row.ebayPriceCents, row.avgCompPriceCents, row.ebayRecommendedPriceCents, null, 0).label).toBe(label);
  });
});
