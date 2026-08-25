import { describe, expect, it } from "vitest";
import {
  applyShippingStrategyToDescription,
  applyShippingStrategyToTitle,
} from "@/lib/ebay/description";
import { generateMirrorDescription } from "@/lib/mirror/seo";

describe("shipping-aware listing copy", () => {
  const original = '<div><h2>Fast Free Shipping</h2><p>FREE shipping on all orders</p><p>Product details</p></div>';

  it("renders new buyer-paid mirror copy without a free-shipping claim", () => {
    const description = generateMirrorDescription({
      title: "T", brand: "B", bulletPoints: ["Feature"], description: "", category: "Home", imageUrls: [],
    }, 700);
    expect(description).toContain("Buyer-paid shipping of $7.00");
    expect(description.toLowerCase()).not.toContain("free shipping");
  });

  it("removes every free-shipping claim for buyer-paid offers", () => {
    const description = applyShippingStrategyToDescription(original, 525);
    expect(description).toContain("Buyer-paid shipping of $5.25 applies");
    expect(description.toLowerCase()).not.toContain("free shipping");
    expect(applyShippingStrategyToTitle("Product - Fast Free Shipping", 525)).toBe("Product");
    expect(applyShippingStrategyToDescription(description, 525)).toBe(description);
  });

  it("explicitly advertises free shipping and removes stale paid wording", () => {
    const paid = '<div><p>Buyer-paid shipping of $7.00 is shown separately at checkout</p></div>';
    const description = applyShippingStrategyToDescription(paid, 0);
    expect(description).toMatch(/free shipping is included/i);
    expect(description.toLowerCase()).not.toContain("buyer-paid shipping");
  });
});
