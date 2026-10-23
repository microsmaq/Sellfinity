import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ user: vi.fn(), listing: vi.fn(), source: vi.fn(), sourceLookup: vi.fn(), stock: vi.fn(), updateListings: vi.fn(), updateListing: vi.fn(), suppress: vi.fn(), end: vi.fn(), activity: vi.fn(), winners: vi.fn(), bans: vi.fn(), listingRows: vi.fn(), getSellerListings: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  adminArbitrageProduct: { findUnique: mocks.source, findMany: mocks.bans },
  listing: { findFirst: mocks.listing, findMany: mocks.listingRows, updateMany: mocks.updateListings, update: mocks.updateListing },
  product: { update: mocks.stock }, ebayListingSuppression: { upsert: mocks.suppress },
  $transaction: async (work: unknown[]) => Promise.all(work),
} }));
vi.mock("@/lib/ebay", () => ({ getEbayClientForUser: async () => ({ endListing: mocks.end, getSellerListings: mocks.getSellerListings }) }));
vi.mock("@/lib/listings/activity-history", () => ({ recordListingActivity: mocks.activity }));
vi.mock("@/lib/listings/winner", () => ({ getProtectedPriceListings: mocks.winners }));
vi.mock("@/lib/listings/admin-amazon-source", () => ({ getAdminAmazonSourceWithFallback: mocks.sourceLookup, NoUsableAmazonSourceError: class extends Error {} }));
import { prepareConfigurableSmartSync, processConfigurableSmartSyncItem } from "@/lib/actions/ebay-listings";
import type { SmartSyncOptions } from "@/lib/listings/smart-sync-options";
const options: SmartSyncOptions = { refreshEbayListings: true, refreshAmazonData: false, checkLiveAmazonPrices: false, applySuggestedPrices: false, updateListingImages: false, endUnavailableListings: false, relistRecoveredProducts: false };
const listing = { id: "listing", userId: "owner", title: "Banned item", status: "ACTIVE", ebayListingId: "123", priceCents: 1299, product: { id: "product", supplierName: "Amazon", supplierProductId: "B012345678", sku: "B012345678" } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "owner" });
  mocks.listing.mockResolvedValue(listing);
  mocks.source.mockResolvedValue({ bannedAt: new Date() });
  mocks.getSellerListings.mockResolvedValue([]);
  mocks.listingRows.mockResolvedValue([]);
  mocks.bans.mockResolvedValue([{ asin: "B012345678" }]);
});
describe("mandatory admin ban enforcement during user refresh", () => {
  it("ends banned listings on eBay even with ordinary delisting off and live Amazon reporting available", async () => {
    expect(await processConfigurableSmartSyncItem("listing", options, true)).toMatchObject({ status: "success", outcome: "ended" });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith("123");
    expect(mocks.updateListings).toHaveBeenCalledWith({ where: { userId: "owner", ebayListingId: "123" }, data: { status: "ENDED", endedAt: expect.any(Date), endedReason: "ADMIN_BANNED" } });
    expect(mocks.sourceLookup).not.toHaveBeenCalled(); expect(mocks.winners).not.toHaveBeenCalled();
    expect(mocks.suppress).toHaveBeenCalled();
  });
  it("keeps the listing active and reports failure if eBay refuses the removal", async () => {
    mocks.end.mockRejectedValue(new Error("eBay unavailable"));
    await expect(processConfigurableSmartSyncItem("listing", options)).rejects.toThrow("eBay unavailable");
    expect(mocks.updateListings).not.toHaveBeenCalled(); expect(mocks.suppress).not.toHaveBeenCalled();
  });
  it("catches a ban applied after the initial source check", async () => {
    mocks.source.mockResolvedValue(null);
    mocks.sourceLookup.mockResolvedValue({ bannedAt: new Date() });
    expect(await processConfigurableSmartSyncItem("listing", options)).toMatchObject({ outcome: "ended" });
    expect(mocks.end).toHaveBeenCalledWith("123");
  });
  it("queues banned active listings when only the eBay refresh option is selected", async () => {
    mocks.listingRows.mockResolvedValueOnce([]).mockResolvedValueOnce([listing]);
    expect(await prepareConfigurableSmartSync(options)).toMatchObject({ candidates: [{ listingId: "listing", ebayListingId: "123" }] });
    expect(mocks.listingRows.mock.calls[1][0].where).toMatchObject({ userId: "owner", OR: [{ status: "ACTIVE", product: { supplierName: "Amazon", OR: [{ supplierProductId: { in: ["B012345678"] } }, { sku: { in: ["B012345678"] } }] } }] });
  });
  it("requires the user session before inspecting or ending a listing", async () => {
    mocks.user.mockRejectedValue(new Error("Unauthenticated"));
    await expect(processConfigurableSmartSyncItem("listing", options)).rejects.toThrow("Unauthenticated");
    expect(mocks.listing).not.toHaveBeenCalled(); expect(mocks.end).not.toHaveBeenCalled();
  });
  it("includes banned items beyond the ordinary sync cap, without duplicates", async () => {
    mocks.listingRows.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([listing, listing]);
    expect(await prepareConfigurableSmartSync(options)).toMatchObject({ candidates: [{ listingId: "listing" }] });
    expect(mocks.listingRows.mock.calls[2][0]).not.toHaveProperty("take");
    expect(mocks.listingRows.mock.calls[2][0].where).toMatchObject({ userId: "owner", status: "ACTIVE" });
  });
});
