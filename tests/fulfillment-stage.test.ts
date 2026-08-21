import { describe, expect, it } from "vitest";
import { fulfillmentStage } from "@/lib/orders/fulfillment-stage";

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
