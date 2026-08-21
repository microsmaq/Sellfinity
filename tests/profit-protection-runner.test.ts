import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findOrders: vi.fn(),
  updateOrder: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: mocks.findUser },
    order: { findMany: mocks.findOrders, update: mocks.updateOrder },
  },
}));
vi.mock("@/lib/ebay", () => ({ getEbayClientForUser: vi.fn() }));
vi.mock("@/lib/amazon-email/sync", () => ({
  actualAmazonCost: (item: { verifiedCostCents: number | null }) => item.verifiedCostCents,
}));
vi.mock("@/lib/listings/activity-history", () => ({ recordListingActivity: vi.fn() }));
vi.mock("@/lib/listings/publish", () => ({ publishListingForUser: vi.fn() }));
vi.mock("@/lib/listings/winner", () => ({
  getProtectedPriceListings: vi.fn().mockResolvedValue(new Map()),
}));

import { protectVerifiedOrderMargins } from "@/lib/orders/profit-protection";

function candidate(id: string, verifiedCostCents: number | null) {
  return {
    id,
    listingId: `listing-${id}`,
    quantity: 1,
    salePriceCents: 3_000,
    shippingChargedCents: 0,
    ebayFeeCents: 400,
    listing: {
      id: `listing-${id}`,
      status: "ACTIVE",
      ebayListingId: `ebay-${id}`,
      priceCents: 3_000,
      quantity: 5,
      title: `Listing ${id}`,
      product: { supplierUrl: "https://www.amazon.com/dp/example" },
    },
    amazonPurchaseItem: { verifiedCostCents },
  };
}

describe("profit protection candidate scanning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ ebaySitewideDiscountBps: 0, ebayAdRateBps: 0 });
    mocks.updateOrder.mockResolvedValue({});
  });

  it("skips unverified rows without starving an older verified order", async () => {
    mocks.findOrders.mockResolvedValue([
      ...Array.from({ length: 12 }, (_, index) => candidate(`unverified-${index}`, null)),
      candidate("verified", 1_000),
    ]);

    const result = await protectVerifiedOrderMargins("user-1", { maxOrders: 10 });

    expect(mocks.findOrders).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    expect(result.awaitingVerification).toBe(12);
    expect(result.checked).toBe(1);
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "verified" },
      data: expect.objectContaining({ profitProtectionStatus: "NOT_REQUIRED" }),
    }));
  });
});
