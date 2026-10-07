import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), transaction: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { importCatalogProducts } from "@/lib/actions/catalog-import";
const product = { asin: "B012345678", title: "Test product", category: "Home", priceCents: 1299, shippingCents: null, availability: "AVAILABLE", source: "MANUAL", sourceUrl: "https://www.amazon.com/dp/B012345678" };
describe("direct catalog persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.admin.mockResolvedValue({ id: "admin" });
    mocks.transaction.mockImplementation((work) => work({ adminArbitrageProduct: { findUnique: mocks.findUnique, upsert: mocks.upsert, update: mocks.update } }));
  });
  it("creates a pending record with unknown shipping and an audit source", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await importCatalogProducts([product])).toEqual({ added: 1, updated: 0, skipped: 0 });
    const data = mocks.upsert.mock.calls[0][0].create;
    expect(data).toMatchObject({ status: "PENDING", amazonShippingVerified: false, matchVerdict: "UNVERIFIED", isAmazonBestSeller: false });
    expect(JSON.parse(data.amazonImportDetailsJson)).toMatchObject({ importedBy: "admin", source: "MANUAL" });
  });
  it("skips duplicates without erasing researched records", async () => {
    mocks.findUnique.mockResolvedValue({ id: "existing", status: "PUBLISHED" });
    expect(await importCatalogProducts([product])).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("requires administrator access", async () => {
    mocks.admin.mockRejectedValue(new Error("Forbidden"));
    await expect(importCatalogProducts([product])).rejects.toThrow("Forbidden");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("saves description, bullets and multiple images", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const images = ["https://m.media-amazon.com/images/I/a.jpg", "https://m.media-amazon.com/images/I/b.jpg"];
    await importCatalogProducts([{ ...product, description: "Observed description", bulletPoints: ["Feature one"], images }]);
    expect(mocks.upsert.mock.calls[0][0].create).toMatchObject({ amazonDescription: "Observed description", amazonBulletPointsJson: '["Feature one"]', amazonImageUrl: images[0], amazonImageUrlsJson: JSON.stringify(images) });
  });
  it("fills missing content without changing published matches, prices or freshness", async () => {
    mocks.findUnique.mockResolvedValue({ status: "PUBLISHED", amazonTitle: "Test product", amazonDescription: "", amazonBulletPointsJson: "[]", amazonImageUrlsJson: "[]", amazonImageUrl: null });
    const result = await importCatalogProducts([{ ...product, description: "Details", bulletPoints: ["Feature"], images: ["https://m.media-amazon.com/images/I/a.jpg"] }]);
    expect(result.updated).toBe(1);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.amazonDescription).toBe("Details");
    for (const key of ["status", "amazonPriceCents", "amazonRefreshedAt", "ebayItemId", "matchConfidence"]) expect(data).not.toHaveProperty(key);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("does not erase existing content when an explicit replacement omits it", async () => {
    mocks.findUnique.mockResolvedValue({ amazonDescription: "Original details", amazonBulletPointsJson: '["Original feature"]', amazonImageUrlsJson: '["https://m.media-amazon.com/images/I/a.jpg"]', amazonImageUrl: "https://m.media-amazon.com/images/I/a.jpg" });
    await importCatalogProducts([product], true);
    expect(mocks.upsert.mock.calls[0][0].update).toMatchObject({ amazonDescription: "Original details", amazonBulletPointsJson: '["Original feature"]', amazonImageUrlsJson: '["https://m.media-amazon.com/images/I/a.jpg"]' });
  });
});
