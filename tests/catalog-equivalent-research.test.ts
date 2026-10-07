import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), scrape: vi.fn(), search: vi.fn(), market: vi.fn(), paidSearch: vi.fn(), paidMarket: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findUnique: mocks.findUnique, findMany: mocks.findMany, updateMany: mocks.updateMany } } }));
vi.mock("@/lib/mirror", () => ({ getScraper: () => ({ scrape: mocks.scrape }) }));
vi.mock("@/lib/arbitrage/admin-ebay-market", () => ({ searchAdminEbayProducts: mocks.paidSearch, researchAdminEbayMarket: mocks.paidMarket, getAdminEbayProductByInput: vi.fn() }));
vi.mock("@/lib/ebay/market", () => ({ searchEbayProducts: mocks.search, researchEbayMarket: mocks.market }));
vi.mock("@/lib/mirror/shared-catalog", () => ({ sharedRowToScrapedProduct: (item: { amazonTitle: string }) => ({ title: item.amazonTitle, inStock: true, priceCents: 100, shippingCostCents: 0, imageUrls: [], brand: "Acme" }), sharedAmazonSnapshotData: () => ({ amazonRefreshedAt: new Date(), amazonPriceCents: 100 }) }));
vi.mock("@/lib/arbitrage/product-match", () => ({ assessProductMatchRules: () => ({ verdict: "MATCH", confidence: 100 }), assessProductMatch: async () => ({ verdict: "MATCH", confidence: 100, reason: "Exact identity", method: "AI" }), isApprovedProductMatch: () => true }));
vi.mock("@/lib/arbitrage/admin-catalog", () => ({ publishCatalogProductToUsers: mocks.publish }));
vi.mock("@/lib/arbitrage/pricing", () => ({ arbitrageSuggestedPriceCents: () => 500 }));
vi.mock("@/lib/fees", () => ({ estimateMargin: () => ({ estimatedProfitCents: 200, marginPct: 40 }) }));
import { researchAdminCatalogProduct } from "@/lib/arbitrage/admin-research";
const previousUpdate = new Date("2026-10-01T00:00:00Z");
beforeEach(() => {
  vi.clearAllMocks(); mocks.findUnique.mockResolvedValue({ id: "a", status: "PENDING", updatedAt: previousUpdate, amazonTitle: "Acme AB123 lamp", amazonInStock: true, amazonPriceCents: 100, amazonShippingVerified: true, amazonRefreshedAt: previousUpdate, amazonImportDetailsJson: "{}" });
  mocks.findMany.mockResolvedValue([]); mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.search.mockResolvedValue([{ itemId: "123", title: "Acme AB123 lamp", priceCents: 500, url: "https://www.ebay.com/itm/123", imageUrl: "", category: "Other" }]); mocks.market.mockResolvedValue(null);
});
const options = { storedSource: true, ebayOnly: true, reviewOnly: true };
it("saves even a 100% candidate for review without publishing or paid source calls", async () => {
  await researchAdminCatalogProduct("a", options);
  expect(mocks.search).toHaveBeenCalledWith("Acme AB123 lamp", 50);
  expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a", status: "PENDING", updatedAt: previousUpdate }, data: expect.objectContaining({ status: "NO_MATCH", ebayItemId: "123", amazonRefreshedAt: previousUpdate }) }));
  expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.scrape).not.toHaveBeenCalled(); expect(mocks.paidSearch).not.toHaveBeenCalled(); expect(mocks.paidMarket).not.toHaveBeenCalled();
});
it("does not overwrite a concurrent change when no equivalent is found", async () => {
  mocks.search.mockResolvedValue([]); mocks.updateMany.mockResolvedValue({ count: 0 });
  await expect(researchAdminCatalogProduct("a", options)).rejects.toThrow("changed during research");
  expect(mocks.updateMany.mock.calls[0][0].where.updatedAt).toBe(previousUpdate);
});
it("refuses published products before any external call", async () => {
  mocks.findUnique.mockResolvedValue({ status: "PUBLISHED" });
  await expect(researchAdminCatalogProduct("a", options)).rejects.toThrow("already approved"); expect(mocks.search).not.toHaveBeenCalled();
});
it("holds an otherwise approved imported match when required product content is missing", async () => {
  mocks.findUnique.mockResolvedValue({ id: "a", status: "PENDING", updatedAt: previousUpdate, amazonTitle: "Acme AB123 lamp", amazonInStock: true, amazonPriceCents: 100, amazonShippingVerified: true, amazonRefreshedAt: previousUpdate, amazonImportDetailsJson: '{"source":"BROWSER"}', amazonDescription: "", amazonBulletPointsJson: "[]", amazonImageUrlsJson: "[]" });
  await researchAdminCatalogProduct("a", { storedSource: true, ebayOnly: true });
  expect(mocks.updateMany.mock.calls[0][0].data).toMatchObject({ status: "NO_MATCH", matchReason: expect.stringContaining("content before publishing") });
  expect(mocks.publish).not.toHaveBeenCalled();
});
