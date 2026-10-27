import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ products: vi.fn(), catalog: vi.fn(), market: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  product: { findMany: mocks.products },
  adminArbitrageProduct: { findMany: mocks.catalog },
  ebayMarketMetric: { findMany: mocks.market },
} }));
vi.mock("@/lib/amazon-email/sync", () => ({ actualAmazonCost: () => null }));
vi.mock("@/lib/analytics/traffic", () => ({ loadListingTraffic: vi.fn() }));

import { getProductAnalyticsOverview } from "@/lib/analytics/product-overview";

describe("admin product analytics", () => {
  it("keeps catalog and sales totals while requesting only dashboard fields", async () => {
    const date = new Date("2026-10-20T12:00:00Z");
    mocks.catalog.mockResolvedValue([{ asin: "B000000001", amazonTitle: "Catalog item", amazonImageUrl: null, category: "Home", averageCompetitorPriceCents: null, suggestedPriceCents: null, competitorCount: null, ebayPriceCents: null, createdAt: date, updatedAt: date }]);
    mocks.products.mockResolvedValue([{ userId: "seller", supplierProductId: "B000000001", sku: "sku", title: "Item", imageUrlsJson: "[]", category: "Home", createdAt: date, costCents: 500, shippingCostCents: 0, user: { ebayAdRateBps: 0, ebaySitewideDiscountBps: 0, targetProfitEnabled: false, targetProfitMode: "FIXED", targetProfitMinCents: 0, targetProfitCents: 0, ebayConnection: null }, listings: [{ status: "ACTIVE", priceCents: 1000, ebayListingId: null, updatedAt: date, orders: [{ sourcingStatus: "NOT_PURCHASED", status: "PAID", saleDate: date, quantity: 1, salePriceCents: 1000, shippingChargedCents: 0, ebayFeeCents: 100, cogsCents: 500, shippingCostCents: 0, ebayFinancialsSource: "ESTIMATED", amazonPurchaseItem: null }] }] }]);
    const overview = await getProductAnalyticsOverview({ includeCatalog: true, startDate: new Date("2026-10-01"), endDate: new Date("2026-10-27") });
    expect(overview.totals).toMatchObject({ productCount: 1, sellerCount: 1, unitsSold: 1, revenueCents: 1000, netProfitCents: 400 });
    expect(overview.rows[0]).toMatchObject({ asin: "B000000001", listingCount: 1, activeListings: 1 });
    const catalogSelect = mocks.catalog.mock.calls[0][0].select;
    expect(catalogSelect.amazonDescription).toBeUndefined();
    expect(catalogSelect.amazonImportDetailsJson).toBeUndefined();
    expect(mocks.products.mock.calls[0][0].select.listings.select.orders.select.ebayFeeBreakdownJson).toBeUndefined();
  });
});
