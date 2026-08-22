import { describe, expect, it } from "vitest";
import { retainedEbayListings, type RetainedEbayListing } from "@/lib/listings/local-ebay-cache";

describe("retained eBay listing cache", () => {
  const active: RetainedEbayListing = {
    ebayListingId: "123456789012",
    status: "ACTIVE",
    title: "Cached listing",
    priceCents: 1_499,
    quantity: 3,
    imageUrlsJson: JSON.stringify(["https://example.com/product.jpg"]),
    publishedAt: new Date("2026-08-20T12:00:00.000Z"),
  };

  it("renders an active listing from local data without an eBay request", () => {
    expect(retainedEbayListings([active], new Set(), "https://www.ebay.com")).toEqual([{
      ebayListingId: "123456789012",
      title: "Cached listing",
      priceCents: 1_499,
      url: "https://www.ebay.com/itm/123456789012",
      imageUrl: "https://example.com/product.jpg",
      quantity: 3,
      listingDate: new Date("2026-08-20T12:00:00.000Z"),
    }]);
  });

  it("excludes drafts, ended listings, missing IDs, and suppression tombstones", () => {
    const rows = [
      { ...active, status: "DRAFT" },
      { ...active, status: "ENDED" },
      { ...active, ebayListingId: null },
      active,
    ];
    expect(retainedEbayListings(rows, new Set([active.ebayListingId!]), "https://www.ebay.com")).toEqual([]);
  });
});
