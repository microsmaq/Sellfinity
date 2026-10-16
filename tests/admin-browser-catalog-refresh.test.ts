import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateShared: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findMany: mocks.findMany, update: mocks.update }, arbitrageItem: { updateMany: mocks.updateShared }, $transaction: mocks.transaction } }));
import { adminUpdateAmazonCostsFromBrowser } from "@/lib/actions/admin-arbitrage";
const row = { id: "one", asin: "B012345678", amazonShippingCents: 499, amazonShippingVerified: true, amazonImportDetailsJson: '{"source":"MANUAL","variant":"Old","bestsellerRank":4}', ebayPriceCents: null };
const details = { asin: row.asin, title: "Updated Amazon title", brand: "New brand", category: "Home", variant: "Black", description: "Current product description", bulletPoints: ["Current feature"], images: ["https://m.media-amazon.com/images/I/new.jpg"], priceCents: 1299, shippingCents: 0, availability: "AVAILABLE", source: "BROWSER", sourceUrl: `https://www.amazon.com/dp/${row.asin}` };
beforeEach(() => { vi.resetAllMocks(); mocks.admin.mockResolvedValue({ id: "admin" }); mocks.findMany.mockResolvedValue([row]); mocks.transaction.mockResolvedValue([]); });
describe("full admin browser catalog refresh", () => {
  it("saves all readable product details alongside costs without resetting approved matches", async () => {
    expect(await adminUpdateAmazonCostsFromBrowser([row.id], 1299, 0, details)).toMatchObject({ updatedIds: [row.id], detailsUpdated: true });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ amazonTitle: details.title, amazonBrand: details.brand, category: "Home", amazonDescription: details.description, amazonBulletPointsJson: JSON.stringify(details.bulletPoints), amazonImageUrl: details.images[0], amazonImageUrlsJson: JSON.stringify(details.images), amazonUrl: details.sourceUrl, amazonPriceCents: 1299, amazonShippingCents: 0, amazonShippingVerified: true, amazonInStock: true });
    expect(JSON.parse(data.amazonImportDetailsJson)).toMatchObject({ source: "MANUAL", variant: "Black", bestsellerRank: 4, contentRefreshSource: "BROWSER", contentCheckedAt: expect.any(String), contentRefreshedAt: expect.any(String) });
    for (const field of ["status", "matchVerdict", "matchConfidence", "matchMethod", "ebayItemId", "ebayTitle", "lastResearchedAt"]) expect(data).not.toHaveProperty(field);
    expect(mocks.updateShared.mock.calls[0][0].data).toMatchObject({ amazonTitle: details.title, amazonUrl: details.sourceUrl });
    expect(mocks.updateShared.mock.calls[0][0].data).not.toHaveProperty("imageUrl"); // eBay comparison image, not source gallery.
  });
  it("preserves existing fields and shipping when the current page omits them", async () => {
    await adminUpdateAmazonCostsFromBrowser([row.id], 1299, null, { ...details, brand: "", category: "Other", variant: "", description: "", bulletPoints: [], images: [], shippingCents: null });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.amazonShippingCents).toBe(499); expect(data).not.toHaveProperty("amazonShippingVerified");
    for (const field of ["amazonDescription", "amazonBulletPointsJson", "amazonImageUrl", "amazonImageUrlsJson", "amazonBrand", "category"]) expect(data).not.toHaveProperty(field);
    expect(JSON.parse(data.amazonImportDetailsJson).variant).toBe("Old");
  });
  it("supports older price-only helpers without claiming content was refreshed", async () => {
    expect(await adminUpdateAmazonCostsFromBrowser([row.id], 1299, null)).toMatchObject({ detailsUpdated: false });
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("amazonDescription");
    expect(JSON.parse(mocks.update.mock.calls[0][0].data.amazonImportDetailsJson)).not.toHaveProperty("contentRefreshedAt");
  });
  it.each([
    { ...details, asin: "B099999999", sourceUrl: "https://www.amazon.com/dp/B099999999" },
    { ...details, priceCents: 799 }, { ...details, shippingCents: 999 }, { ...details, availability: "UNAVAILABLE" },
    { ...details, images: ["https://evil.example/photo.jpg"] }, { ...details, source: "MANUAL" },
  ])("refuses cross-ASIN, inconsistent or invalid evidence without any writes: %j", async (product) => {
    expect(await adminUpdateAmazonCostsFromBrowser([row.id], 1299, 0, product)).toHaveProperty("error");
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.updateShared).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("rejects a mixed-ASIN batch before writing any product", async () => {
    mocks.findMany.mockResolvedValue([row, { ...row, id: "two", asin: "B099999999" }]);
    expect(await adminUpdateAmazonCostsFromBrowser(["one", "two"], 1299, 0, details)).toHaveProperty("error");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires admin access", async () => {
    mocks.admin.mockRejectedValue(new Error("Forbidden"));
    await expect(adminUpdateAmazonCostsFromBrowser([row.id], 1299, 0, details)).rejects.toThrow("Forbidden");
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
