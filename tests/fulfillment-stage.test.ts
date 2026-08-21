import { describe, expect, it } from "vitest";
import { fulfillmentNeedsAction, fulfillmentStage } from "@/lib/orders/fulfillment-stage";

describe("fulfillmentStage", () => {
  it("shows an ordered Amazon purchase as awaiting shipment", () => {
    expect(fulfillmentStage({
      ebayStatus: "PAID",
      sourcingStatus: "DELIVERED",
      amazonPurchaseStatus: "ORDERED",
      hasShipmentDetails: false,
    })).toBe("PURCHASED");
  });

  it("does not show shipped or delivered without shipment details", () => {
    expect(fulfillmentStage({
      ebayStatus: "PAID",
      sourcingStatus: "SHIPPED",
      amazonPurchaseStatus: "SHIPPED",
      hasShipmentDetails: false,
    })).toBe("PURCHASED");
    expect(fulfillmentStage({
      ebayStatus: "PAID",
      sourcingStatus: "DELIVERED",
      amazonPurchaseStatus: "DELIVERED",
      hasShipmentDetails: false,
    })).toBe("PURCHASED");
  });

  it("advances only when shipment evidence is available", () => {
    expect(fulfillmentStage({
      ebayStatus: "SHIPPED",
      sourcingStatus: "SHIPPED",
      amazonPurchaseStatus: "SHIPPED",
      hasShipmentDetails: true,
    })).toBe("IN_TRANSIT");
    expect(fulfillmentStage({
      ebayStatus: "SHIPPED",
      sourcingStatus: "DELIVERED",
      amazonPurchaseStatus: "DELIVERED",
      hasShipmentDetails: true,
    })).toBe("DELIVERED");
  });
});

describe("fulfillment needs action", () => {
  it("keeps every active order without tracking in needs action", () => {
    expect(fulfillmentNeedsAction({ stage: "AWAITING", trackingNumber: null })).toBe(true);
    expect(fulfillmentNeedsAction({ stage: "PURCHASED", trackingNumber: null })).toBe(true);
    expect(fulfillmentNeedsAction({ stage: "IN_TRANSIT", trackingNumber: null })).toBe(true);
    expect(fulfillmentNeedsAction({ stage: "DELIVERED", trackingNumber: null })).toBe(true);
  });

  it("excludes completed active rows only after tracking exists", () => {
    expect(fulfillmentNeedsAction({ stage: "IN_TRANSIT", trackingNumber: "1Z999AA10123456784" })).toBe(false);
    expect(fulfillmentNeedsAction({ stage: "DELIVERED", trackingNumber: "1Z999AA10123456784" })).toBe(false);
    expect(fulfillmentNeedsAction({ stage: "CANCELLED", trackingNumber: null })).toBe(false);
    expect(fulfillmentNeedsAction({ stage: "REFUNDED", trackingNumber: null })).toBe(false);
  });
});
