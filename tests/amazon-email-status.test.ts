import { describe, expect, it } from "vitest";
import { amazonEmailStatus } from "@/lib/amazon-email/parser";

describe("amazonEmailStatus", () => {
  it("keeps shipment emails shipped when they mention delivery confirmation", () => {
    expect(
      amazonEmailStatus(
        "Shipped: your Amazon.com order",
        "Your package has shipped. Delivery confirmation will be available from the carrier.",
      ),
    ).toBe("SHIPPED");
  });

  it("does not treat an expected delivery date as delivered", () => {
    expect(
      amazonEmailStatus(
        "Your package has shipped",
        "Expected delivery tomorrow. Track your shipment for updates.",
      ),
    ).toBe("SHIPPED");
  });

  it("does not treat a future delivered-to address sentence as delivered", () => {
    expect(
      amazonEmailStatus(
        "Shipped: your Amazon.com order",
        "Your shipment will be delivered to the address below.",
      ),
    ).toBe("SHIPPED");
  });

  it("recognizes an explicit delivered subject", () => {
    expect(amazonEmailStatus("Delivered: your package", "Left near the front door.")).toBe("DELIVERED");
  });

  it("recognizes an explicit delivered statement in the message", () => {
    expect(
      amazonEmailStatus("Your Amazon.com order update", "Your package has been delivered today."),
    ).toBe("DELIVERED");
  });

  it("treats out for delivery as shipped until arrival is confirmed", () => {
    expect(amazonEmailStatus("Out for delivery", "Your package is on the way.")).toBe("SHIPPED");
  });
});
