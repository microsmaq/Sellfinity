import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findOrders: vi.fn(),
  updateOrder: vi.fn(),
  updateManyOrders: vi.fn(),
  updateListing: vi.fn(),
  transaction: vi.fn(),
  updateEbayListing: vi.fn(),
  prepareImages: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: mocks.findUser },
    order: { findMany: mocks.findOrders, update: mocks.updateOrder, updateMany: mocks.updateManyOrders },
    listing: { update: mocks.updateListing },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/ebay", () => ({
  getEbayClientForUser: vi.fn(async () => ({ updateListing: mocks.updateEbayListing })),
}));
vi.mock("@/lib/ebay/image-policy", () => ({
  isEbayPicturePolicyError: (message: string) => message.includes("500 pixels"),
  prepareEbayImages: mocks.prepareImages,
}));
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
      description: `Description for ${id}`,
      imageUrlsJson: '["https://i.ebayimg.com/undersized.jpg"]',
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
    mocks.updateManyOrders.mockResolvedValue({ count: 0 });
    mocks.updateListing.mockResolvedValue({});
    mocks.transaction.mockResolvedValue([]);
    mocks.updateEbayListing.mockResolvedValue(undefined);
    mocks.prepareImages.mockResolvedValue({
      imageUrls: ["https://sellfinity.app/api/generated-images/repaired"],
      repaired: 1,
      rejected: 0,
    });
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

  it("repairs an undersized legacy photo and retries the protected price update", async () => {
    mocks.findUser.mockResolvedValue({
      ebaySitewideDiscountBps: 0,
      ebayAdRateBps: 0,
      targetProfitEnabled: false,
      targetProfitCents: 0,
      pricingStrategy: "FREE_SHIPPING",
    });
    mocks.findOrders.mockResolvedValue([candidate("picture-repair", 5_000)]);
    mocks.updateEbayListing
      .mockRejectedValueOnce(new Error("Use a picture that is at least 500 pixels on the longest side"))
      .mockResolvedValueOnce(undefined);

    const result = await protectVerifiedOrderMargins("user-1", {
      orderIds: ["picture-repair"],
    });
    expect(result.adjusted).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.prepareImages).toHaveBeenCalledWith(
      "user-1",
      ["https://i.ebayimg.com/undersized.jpg"],
    );
    expect(mocks.updateEbayListing).toHaveBeenLastCalledWith(
      "ebay-picture-repair",
      expect.objectContaining({
        imageUrls: ["https://sellfinity.app/api/generated-images/repaired"],
      }),
    );
    expect(mocks.updateManyOrders).toHaveBeenCalledWith({
      where: expect.objectContaining({
        listingId: "listing-picture-repair",
        id: { not: "picture-repair" },
        OR: expect.arrayContaining([
          expect.objectContaining({
            profitProtectionStatus: { in: ["FAILED", "REVIEW_REQUIRED"] },
            profitProtectionNewPriceCents: { lte: expect.any(Number) },
          }),
        ]),
      }),
      data: expect.objectContaining({
        profitProtectionStatus: "ALREADY_PROTECTED",
        profitProtectionError: null,
      }),
    });
  });

  it("includes previous failures in an automatic refresh retry", async () => {
    mocks.findOrders.mockResolvedValue([]);

    await protectVerifiedOrderMargins("user-1", {
      maxOrders: 200,
      retryFailures: true,
    });

    expect(mocks.findOrders).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { profitProtectionStatus: null },
          { profitProtectionStatus: "FAILED" },
        ],
      }),
      take: 2_000,
    }));
  });

  it("updates a shared listing once at the highest required protected price", async () => {
    mocks.findUser.mockResolvedValue({
      ebaySitewideDiscountBps: 0,
      ebayAdRateBps: 0,
      targetProfitEnabled: false,
      targetProfitCents: 0,
      pricingStrategy: "FREE_SHIPPING",
    });
    const lower = candidate("shared-lower", 4_000);
    const higher = candidate("shared-higher", 6_000);
    for (const order of [lower, higher]) {
      order.listingId = "shared-listing";
      order.listing.id = "shared-listing";
      order.listing.ebayListingId = "shared-ebay-item";
    }
    mocks.findOrders.mockResolvedValue([lower, higher]);

    const result = await protectVerifiedOrderMargins("user-1", { maxOrders: 10 });

    expect(result.adjusted).toBe(1);
    expect(mocks.updateEbayListing).toHaveBeenCalledTimes(1);
    expect(mocks.updateEbayListing).toHaveBeenCalledWith(
      "shared-ebay-item",
      expect.objectContaining({ priceCents: expect.any(Number) }),
    );
    expect(mocks.updateManyOrders).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        listingId: "shared-listing",
        OR: expect.arrayContaining([{ id: { in: ["shared-lower"] } }]),
      }),
      data: expect.objectContaining({ profitProtectionStatus: "ALREADY_PROTECTED" }),
    }));
  });

  it("uses free shipping when a protected listing needs no more than one dollar of shipping", async () => {
    mocks.findUser.mockResolvedValue({
      ebaySitewideDiscountBps: 0,
      ebayAdRateBps: 0,
      targetProfitEnabled: false,
      targetProfitCents: 0,
      pricingStrategy: "AI",
    });
    mocks.findOrders.mockResolvedValue([candidate("small-shipping-gap", 2_500)]);

    const result = await protectVerifiedOrderMargins("user-1", { maxOrders: 10 });

    expect(result.adjusted).toBe(1);
    expect(mocks.updateEbayListing).toHaveBeenCalledWith(
      "ebay-small-shipping-gap",
      expect.objectContaining({
        priceCents: expect.any(Number),
        buyerShippingCents: 0,
      }),
    );
  });
});
