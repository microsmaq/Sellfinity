import { describe, expect, it } from "vitest";
import {
  EBAY_TITLE_MAX,
  LISTING_QUANTITY_CAP,
  generateListing,
  generateTitle,
} from "@/lib/listings/generate";

describe("generateTitle", () => {
  it("appends the shipping suffix when it fits", () => {
    const title = generateTitle("Compact Widget");
    expect(title).toBe("Compact Widget - Fast Free Shipping");
  });

  it("keeps the raw title when the suffix would overflow", () => {
    const raw = "x".repeat(75);
    expect(generateTitle(raw)).toBe(raw);
  });

  it("truncates over-long titles at a word boundary within the limit", () => {
    const raw =
      "Extremely Long Product Title With Many Descriptive Keywords For Search Optimization And More Words";
    const title = generateTitle(raw);
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX);
    expect(title.endsWith(" ")).toBe(false);
    // Should not cut a word in half: the result must be a prefix of raw ending
    // at a word boundary.
    expect(raw.startsWith(title)).toBe(true);
    expect(raw[title.length]).toBe(" ");
  });
});

describe("generateListing", () => {
  const input = {
    title: "Test Product",
    description: "A useful thing.",
    category: "Home & Kitchen",
    imageUrls: ["https://example.com/a.jpg"],
    suggestedPriceCents: 1999,
    supplierStock: 100,
  };

  it("caps quantity at the oversell buffer", () => {
    expect(generateListing(input).quantity).toBe(LISTING_QUANTITY_CAP);
  });

  it("uses supplier stock when below the cap", () => {
    expect(generateListing({ ...input, supplierStock: 2 }).quantity).toBe(2);
  });

  it("carries price and images through and mentions the product in the description", () => {
    const listing = generateListing(input);
    expect(listing.priceCents).toBe(1999);
    expect(listing.imageUrls).toEqual(input.imageUrls);
    expect(listing.description).toContain("A useful thing.");
    expect(listing.description).toContain("returns");
  });
});
