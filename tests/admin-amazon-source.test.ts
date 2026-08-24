import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getSharedAmazonProduct: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { adminArbitrageProduct: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/mirror/shared-catalog", () => ({
  getSharedAmazonProduct: mocks.getSharedAmazonProduct,
}));

import { getAdminAmazonSourceWithFallback } from "@/lib/listings/admin-amazon-source";

describe("admin Amazon source fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reuses a usable shared row without a provider lookup", async () => {
    mocks.findUnique.mockResolvedValue({ asin: "B012345678", amazonPriceCents: 2_499 });

    const source = await getAdminAmazonSourceWithFallback("b012345678");

    expect(mocks.getSharedAmazonProduct).not.toHaveBeenCalled();
    expect(source.sharedCatalogPopulated).toBe(false);
  });

  it("populates a missing ASIN once and reads back the saved admin row", async () => {
    const saved = { asin: "B087654321", amazonPriceCents: 3_199 };
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
    mocks.getSharedAmazonProduct.mockResolvedValue({ sourceId: saved.asin });

    const source = await getAdminAmazonSourceWithFallback(saved.asin);

    expect(mocks.getSharedAmazonProduct).toHaveBeenCalledTimes(1);
    expect(mocks.getSharedAmazonProduct).toHaveBeenCalledWith(saved.asin, {
      providerOnCatalogMiss: true,
    });
    expect(source).toMatchObject({ ...saved, sharedCatalogPopulated: true });
  });

  it("returns an actionable error when the provider has no purchasable product", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.getSharedAmazonProduct.mockResolvedValue(null);

    await expect(getAdminAmazonSourceWithFallback("B000000000")).rejects.toThrow(
      "Rainforest returned no purchasable product data",
    );
  });
});
