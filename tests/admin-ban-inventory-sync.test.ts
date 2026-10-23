import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ listings: vi.fn(), bans: vi.fn(), stock: vi.fn(), ended: vi.fn(), user: vi.fn(), run: vi.fn(), finish: vi.fn(), protected: vi.fn(), endEbay: vi.fn(), provider: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  listing: { findMany: mocks.listings, update: mocks.ended },
  adminArbitrageProduct: { findMany: mocks.bans }, product: { update: mocks.stock },
  user: { findUnique: mocks.user }, syncRun: { create: mocks.run, update: mocks.finish },
  $transaction: async (work: unknown[]) => Promise.all(work),
} }));
vi.mock("@/lib/listings/winner", () => ({ getProtectedPriceListings: mocks.protected }));
import { runSync, type SyncDeps } from "@/lib/sync/engine";
const deps = { provider: { getProductState: mocks.provider }, ebay: { endListing: mocks.endEbay } } as unknown as SyncDeps;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listings.mockResolvedValue([{ id: "listing", ebayListingId: "123", product: { id: "product", supplierName: "Amazon", supplierProductId: "B012345678", sku: "B012345678" } }]);
  mocks.bans.mockResolvedValue([{ asin: "B012345678" }]);
  mocks.protected.mockResolvedValue(new Map([["listing", {}]]));
  mocks.run.mockResolvedValue({ id: "run" });
});
it("ends a banned winner during inventory sync without checking Amazon or consulting ignored issues", async () => {
  expect(await runSync("owner", deps)).toMatchObject({ issuesAutoFixed: 1, listingsChecked: 1 });
  expect(mocks.endEbay).toHaveBeenCalledWith("123");
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(mocks.ended.mock.calls[0][0].data).toMatchObject({ status: "ENDED", quantity: 0, endedReason: "ADMIN_BANNED" });
});
it("does not mark the listing ended when eBay removal fails", async () => {
  mocks.endEbay.mockRejectedValue(new Error("Network failure"));
  await expect(runSync("owner", deps)).rejects.toThrow("Network failure");
  expect(mocks.ended).not.toHaveBeenCalled();
});
