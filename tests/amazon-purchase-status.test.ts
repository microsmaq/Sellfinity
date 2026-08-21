import { describe, expect, it } from "vitest";
import { sourcingStatusForAmazonPurchase } from "@/lib/amazon-email/status";

describe("sourcingStatusForAmazonPurchase", () => {
  it("keeps cancellation terminal during initial reconciliation", () => {
    expect(sourcingStatusForAmazonPurchase("CANCELLED")).toBe("CANCELLED");
  });

  it("maps the remaining Amazon lifecycle states", () => {
    expect(sourcingStatusForAmazonPurchase("ORDERED")).toBe("PURCHASED");
    expect(sourcingStatusForAmazonPurchase("SHIPPED")).toBe("SHIPPED");
    expect(sourcingStatusForAmazonPurchase("DELIVERED")).toBe("DELIVERED");
  });
});
