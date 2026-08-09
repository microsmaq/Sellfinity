import { describe, expect, it } from "vitest";
import { parseAmazonEmail } from "@/lib/amazon-email/parser";

describe("Amazon purchase email parser", () => {
  it("extracts an order, exact ASIN, quantities, and actual charges", () => {
    const parsed = parseAmazonEmail({
      subject: "Your Amazon.com order #111-2222222-3333333",
      sentAt: new Date("2026-08-01T12:00:00Z"),
      html: `<a href="https://www.amazon.com/gp/product/B0ABC12345">Premium Widget 12 inch Blue</a>
        Qty: 2 $19.99 Item(s) Subtotal: $39.98 Shipping & Handling: $5.00
        Estimated tax to be collected: $3.60 Promotion Applied: $2.00 Order Total: $46.58`,
    });
    expect(parsed?.amazonOrderId).toBe("111-2222222-3333333");
    expect(parsed?.items[0]).toMatchObject({ asin: "B0ABC12345", quantity: 2, unitPriceCents: 1999 });
    expect(parsed?.shippingCents).toBe(500);
    expect(parsed?.taxCents).toBe(360);
    expect(parsed?.discountCents).toBe(200);
    expect(parsed?.totalCents).toBe(4658);
  });

  it("recognizes shipment state and tracking", () => {
    const parsed = parseAmazonEmail({ subject: "Your order has shipped", text: "Order 111-2222222-3333333 Tracking number: 1Z999AA10123456784" });
    expect(parsed?.status).toBe("SHIPPED");
    expect(parsed?.trackingNumber).toBe("1Z999AA10123456784");
  });

  it("retains Amazon's signed tracking link when the email omits the carrier number", () => {
    const parsed = parseAmazonEmail({
      subject: "Shipped: your Amazon.com order",
      html: `Order 111-2222222-3333333 <a href="https://www.amazon.com/gp/your-account/ship-track?orderId=111-2222222-3333333">Track package</a>`,
    });
    expect(parsed?.status).toBe("SHIPPED");
    expect(parsed?.trackingNumber).toBeNull();
    expect(parsed?.trackingUrl).toBe("https://www.amazon.com/gp/your-account/ship-track?orderId=111-2222222-3333333");
  });

  it("retains an Amazon delivery item name from a signed redirect without an ASIN", () => {
    const parsed = parseAmazonEmail({
      subject: "Delivered: your Amazon.com order",
      html: `Order 111-2222222-3333333
        <a href="https://www.amazon.com/gp/r.html?C=signed-delivery-link">Adjustable Laptop Stand Aluminum Ergonomic Riser</a>`,
    });
    expect(parsed?.status).toBe("DELIVERED");
    expect(parsed?.items[0]).toMatchObject({
      asin: null,
      title: "Adjustable Laptop Stand Aluminum Ergonomic Riser",
    });
  });

  it("extracts the Amazon shipping recipient", () => {
    const parsed = parseAmazonEmail({
      subject: "Your Amazon.com order #111-2222222-3333333",
      text: "Order 111-2222222-3333333\nShip to:\nMaria D. Santos\n123 Main Street Apt 4\nLos Angeles, CA 90001\nOrder Total: $24.99",
    });
    expect(parsed?.recipientName).toBe("Maria D. Santos");
    expect(parsed?.deliveryAddressLine1).toBe("123 Main Street Apt 4");
    expect(parsed?.deliveryPostalCode).toBe("90001");
  });

  it("ignores non-order messages", () => {
    expect(parseAmazonEmail({ subject: "Amazon recommendations", text: "Products you may like" })).toBeNull();
  });
});
