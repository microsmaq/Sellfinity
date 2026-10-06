import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), requireAdmin: vi.fn(), catalogFind: vi.fn(), listingFind: vi.fn(),
  catalogUpdate: vi.fn(), productUpdate: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db", () => ({ db: {
  adminArbitrageProduct: { findMany: mocks.catalogFind, updateMany: mocks.catalogUpdate },
  listing: { findMany: mocks.listingFind }, product: { updateMany: mocks.productUpdate }, $transaction: mocks.transaction,
} }));
import { recordAmazonCheckAttempt } from "../src/lib/actions/amazon-checks";

describe("shared Amazon check attempts", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.requireUser.mockResolvedValue({ id: "seller" }); mocks.requireAdmin.mockResolvedValue({ id: "admin" }); });
  it("records attempted checks across the shared catalog and products without changing prices or stock", async () => {
    mocks.catalogFind.mockResolvedValue([{ asin: "B012345678" }]);
    await recordAmazonCheckAttempt(["catalog-id"], "ADMIN");
    expect(mocks.requireAdmin).toHaveBeenCalled();
    expect(mocks.catalogUpdate).toHaveBeenCalledWith({ where: { asin: { in: ["B012345678"] } }, data: { amazonCheckedAt: expect.any(Date) } });
    expect(mocks.productUpdate.mock.calls[0][0].data).toEqual({ amazonCheckedAt: expect.any(Date) });
  });
  it("only resolves a seller's own listing IDs before recording ASIN attempts", async () => {
    mocks.listingFind.mockResolvedValue([{ product: { sku: "B012345678" } }]);
    await recordAmazonCheckAttempt(["ebay-id"], "LISTINGS");
    expect(mocks.listingFind).toHaveBeenCalledWith({ where: { userId: "seller", ebayListingId: { in: ["ebay-id"] } }, select: { product: { select: { sku: true } } } });
  });
  it("does not write timestamps for unresolved or unauthorized listing IDs", async () => {
    mocks.listingFind.mockResolvedValue([]);
    await recordAmazonCheckAttempt(["someone-elses-id"], "LISTINGS");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
