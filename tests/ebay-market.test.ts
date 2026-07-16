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
        { itemId: "v1|OWN123|0", title: "Wireless Milk Frother", price: { value: "99.99" } },
        { itemId: "v1|COMP1|0", title: "Wireless Milk Frother", price: { value: "10.00" } },
        { itemId: "v1|COMP2|0", title: "Wireless Milk Frother", price: { value: "20.00" } },
      ],
      "OWN123",
      "Wireless Milk Frother",
    );
    expect(result?.competitorCount).toBe(3);
    expect(result?.averageCompetitorPriceCents).toBe(1500);
    expect(result?.bestSellingPriceCents).toBe(1000);
    expect(result?.estimatedSales30d).toBeGreaterThan(0);
  });

  it("rejects loosely related titles and extreme price outliers", () => {
    const result = summarizeBrowseMarket(
      10,
      [
        { itemId: "v1|1|0", title: "Dyson Airwrap Complete Styler", price: { value: "299.99" } },
        { itemId: "v1|2|0", title: "Dyson Airwrap Diffuser Attachment", price: { value: "44.99" } },
        { itemId: "v1|3|0", title: "Dyson Airwrap Diffuser Genuine", price: { value: "49.99" } },
        { itemId: "v1|4|0", title: "Dyson Airwrap Diffuser New", price: { value: "54.99" } },
        { itemId: "v1|5|0", title: "Universal Hair Diffuser", price: { value: "11.99" } },
      ],
      "OWN",
      "Dyson Airwrap Diffuser",
    );
    expect(result?.bestSellingPriceCents).toBe(4499);
    expect(result?.averageCompetitorPriceCents).toBe(4999);
    expect(result?.competitorCount).toBeLessThan(10);
  });

  it("returns null without priced competitors", () => {
    expect(summarizeBrowseMarket(1, [], "OWN")).toBeNull();
  });
});
