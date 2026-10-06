import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), transaction: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { importCatalogProducts } from "@/lib/actions/catalog-import";
const product = { asin: "B012345678", title: "Test product", category: "Home", priceCents: 1299, shippingCents: null, availability: "AVAILABLE", source: "MANUAL", sourceUrl: "https://www.amazon.com/dp/B012345678" };
describe("direct catalog persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.admin.mockResolvedValue({ id: "admin" });
    mocks.transaction.mockImplementation((work) => work({ adminArbitrageProduct: { findUnique: mocks.findUnique, upsert: mocks.upsert } }));
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
});
