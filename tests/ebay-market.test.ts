import { describe, expect, it } from "vitest";
import {
  marketSearchQuery,
  summarizeBrowseMarket,
} from "@/lib/ebay/market-analysis";

describe("eBay market research", () => {
  it("builds a focused query without listing noise", () => {
    expect(
      marketSearchQuery("Brand New Wireless Milk Frother Set - Fast Free Shipping"),
    ).toBe("wireless milk frother");
  });

  it("excludes the seller's item and summarizes competitor prices", () => {
    const result = summarizeBrowseMarket(
      4,
      [
        { itemId: "v1|OWN123|0", price: { value: "99.99" } },
        { itemId: "v1|COMP1|0", price: { value: "10.00" } },
        { itemId: "v1|COMP2|0", price: { value: "20.00" } },
      ],
      "OWN123",
    );
    expect(result?.competitorCount).toBe(3);
    expect(result?.averageCompetitorPriceCents).toBe(1500);
    expect([1000, 2000]).toContain(result?.bestSellingPriceCents);
    expect(result?.estimatedSales30d).toBeGreaterThan(0);
  });

  it("returns null without priced competitors", () => {
    expect(summarizeBrowseMarket(1, [], "OWN")).toBeNull();
  });
});
