import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/mirror/shared-catalog", () => ({ getSharedAmazonProduct: mocks.lookup }));
import { getAdminAmazonSourceWithFallback } from "@/lib/listings/admin-amazon-source";
describe("daily user sync saved Amazon data", () => {
  beforeEach(() => vi.resetAllMocks());
  it("retains confirmed unavailability even without a saved price", async () => {
    mocks.findUnique.mockResolvedValue({ amazonInStock: false, amazonPriceCents: 0 });
    expect(await getAdminAmazonSourceWithFallback("B012345678", true)).toMatchObject({ amazonInStock: false, sharedCatalogPopulated: false });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("leaves missing sources for review without spending provider credits", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(getAdminAmazonSourceWithFallback("B012345678", true)).rejects.toThrow("left the listing unchanged");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("does not treat unverified imported availability as a reason to delist", async () => {
    mocks.findUnique.mockResolvedValue({ amazonInStock: false, amazonPriceCents: 1299, amazonImportDetailsJson: '{"availability":"UNKNOWN"}' });
    await expect(getAdminAmazonSourceWithFallback("B012345678", true)).rejects.toThrow("availability is unverified");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("does not price imported products with unknown shipping", async () => {
    mocks.findUnique.mockResolvedValue({ amazonInStock: true, amazonPriceCents: 1299, amazonShippingVerified: false });
    await expect(getAdminAmazonSourceWithFallback("B012345678", true)).rejects.toThrow("shipping is unverified");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});
