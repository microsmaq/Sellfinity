import { describe, expect, it } from "vitest";
import { mapBrowseBestSellerItems } from "@/lib/ebay/browse-bestseller-map";

describe("official eBay bestseller fallback", () => {
  it("keeps only item details with an explicit positive estimated sold quantity", () => {
    const rows = mapBrowseBestSellerItems([
      {
        itemId: "v1|123456789012|0",
        title: "Proven Product",
        price: { value: "12.99" },
        shippingOptions: [{ shippingCost: { value: "2.00" } }],
        estimatedAvailabilities: [{ estimatedSoldQuantity: 450 }],
        seller: { username: "trusted-store", feedbackPercentage: "99.8", feedbackScore: 1200 },
      },
      {
        itemId: "v1|223456789012|0",
        title: "Unknown Product",
        price: { value: "10.00" },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: "123456789012",
      quantitySold: 450,
      totalPriceCents: 1499,
      sellerName: "trusted-store",
    });
  });
});
