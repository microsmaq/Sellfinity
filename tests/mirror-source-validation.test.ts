import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ findProduct: vi.fn(), lookup: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { product: { findUnique: mocks.findProduct }, $transaction: mocks.transaction } }));
vi.mock("@/lib/mirror/shared-catalog", () => ({ sharedCatalogScraper: { scrape: mocks.lookup } }));
import { mirrorUrl } from "@/lib/mirror/pipeline";
beforeEach(() => { vi.resetAllMocks(); mocks.findProduct.mockResolvedValue(null); });
it("resolves the reported sponsored product URL to its ASIN before source lookup", async () => {
  mocks.lookup.mockResolvedValue(null);
  const result = await mirrorUrl("user", "https://www.amazon.com/sspa/click?url=%2Fdp%2FB0DQJ6FXXL");
  expect(mocks.findProduct).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_sku: { userId: "user", sku: "B0DQJ6FXXL" } } }));
  expect(result.error).toContain("ASIN B0DQJ6FXXL");
  expect(result.error).not.toContain("Not a recognizable");
});
it("returns a useful source error for both single and bulk publishing without creating a draft", async () => {
  mocks.lookup.mockRejectedValue(new Error("Amazon source B0DQJ6FXXL: saved product details are incomplete. No listing was published."));
  const result = await mirrorUrl("user", "B0DQJ6FXXL");
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("saved product details are incomplete") });
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("rejects invalid product input before database or provider calls", async () => {
  const result = await mirrorUrl("user", "https://evil.example/dp/B0DQJ6FXXL");
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("valid Amazon product URL") });
  expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.findProduct).not.toHaveBeenCalled();
});
it.each([{ sourceId: "B0DQJ6FXXL", inStock: false, priceCents: 799 }, { sourceId: "B0DQJ6FXXL", inStock: true, priceCents: 0 }, { sourceId: "B099999999", inStock: true, priceCents: 799 }])("never creates a draft for unavailable, unpriced or wrong-ASIN data: %j", async (product) => {
  mocks.lookup.mockResolvedValue({ ...product, imageUrls: ["https://example.com/photo.jpg"] });
  expect((await mirrorUrl("user", "B0DQJ6FXXL")).ok).toBe(false);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
