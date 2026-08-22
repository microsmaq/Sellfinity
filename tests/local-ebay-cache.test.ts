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
    updatedAt: new Date("2026-08-20T12:00:00.000Z"),
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

  it("uses a newer eBay snapshot and retains eBay-only listings", () => {
    const snapshots = [{
      ebayListingId: active.ebayListingId!,
      title: "Latest eBay title",
      priceCents: 1_799,
      url: `https://www.ebay.com/itm/${active.ebayListingId}`,
      imageUrl: null,
      quantity: 2,
      listingDate: active.publishedAt,
      updatedAt: new Date("2026-08-22T12:00:00.000Z"),
    }, {
      ebayListingId: "999999999999",
      title: "eBay-only listing",
      priceCents: 2_000,
      url: "https://www.ebay.com/itm/999999999999",
      imageUrl: null,
      quantity: 1,
      listingDate: null,
      updatedAt: new Date("2026-08-22T12:00:00.000Z"),
    }];
    const rows = retainedEbayListings([active], new Set(), "https://www.ebay.com", snapshots);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.ebayListingId === active.ebayListingId)?.priceCents).toBe(1_799);
    expect(rows.some((row) => row.ebayListingId === "999999999999")).toBe(true);
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
