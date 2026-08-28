import { describe, expect, it } from "vitest";
import { amazonStatusCanUploadTracking, ebayCarrierCode, normalizeTrackingNumber, remoteFulfillmentKey, remoteFulfillmentLookupKeys, storedFulfillmentIdentity, trackingAppliesToAsin, trackingCandidateForUpload } from "@/lib/amazon-email/tracking-utils";
import { trackingFromPage } from "@/lib/amazon-email/tracking-resolver-utils";

describe("Amazon tracking normalization", () => {
  it("uploads tracking for both shipped and already-delivered Amazon packages", () => {
    expect(amazonStatusCanUploadTracking("SHIPPED")).toBe(true);
    expect(amazonStatusCanUploadTracking("DELIVERED")).toBe(true);
    expect(amazonStatusCanUploadTracking("ORDERED")).toBe(false);
  });

  it("prioritizes tracking already saved on the fulfillment order", () => {
    expect(trackingCandidateForUpload({
      storedTrackingNumber: "TBA333742771521",
      storedCarrier: "Other",
      amazonTrackingNumber: "TBA-OLD",
      amazonCarrier: "Amazon Logistics",
      amazonStatus: "DELIVERED",
      amazonAttributionSafe: false,
    })).toEqual({ trackingNumber: "TBA333742771521", carrier: "Other" });
  });

  it("still requires safe attribution for tracking sourced only from Amazon", () => {
    expect(trackingCandidateForUpload({
      amazonTrackingNumber: "1Z999AA10123456784",
      amazonCarrier: "UPS",
      amazonStatus: "SHIPPED",
      amazonAttributionSafe: false,
    })).toBeNull();
  });

  it("removes characters eBay does not accept", () => {
    expect(normalizeTrackingNumber("1z 999-aa-10123456784")).toBe("1Z999AA10123456784");
  });

  it("maps supported carriers and safely falls back for Amazon Logistics", () => {
    expect(ebayCarrierCode("UPS", "1Z999AA10123456784")).toBe("UPS");
    expect(ebayCarrierCode("USPS", "9400111899223856928499")).toBe("USPS");
    expect(ebayCarrierCode("FedEx", "123456789012")).toBe("FedEx");
    expect(ebayCarrierCode("Amazon Logistics", "TBA123456789000")).toBe("Other");
  });

  it("uses the same composite key stored by eBay order import", () => {
    expect(remoteFulfillmentKey("12-34567-89012", "10001234567890"))
      .toBe("12-34567-89012-10001234567890");
  });

  it("supports a legacy order-id alias only for unambiguous single-line orders", () => {
    expect(remoteFulfillmentLookupKeys("12-34567-89012", "10001234567890", 1))
      .toEqual(["12-34567-89012-10001234567890", "12-34567-89012"]);
    expect(remoteFulfillmentLookupKeys("12-34567-89012", "10001234567890", 2))
      .toEqual(["12-34567-89012-10001234567890"]);
  });

  it("recovers an exact eBay line from stored current and legacy identities", () => {
    expect(storedFulfillmentIdentity({
      ebayOrderId: "02-14985-01871-10083068706302",
      ebayCheckoutOrderId: "02-14985-01871",
    })).toEqual({ orderId: "02-14985-01871", lineItemId: "10083068706302" });
    expect(storedFulfillmentIdentity({
      ebayOrderId: "13-14962-68653-10085054611113",
    })).toEqual({ orderId: "13-14962-68653", lineItemId: "10085054611113" });
  });

  it("refuses a stored id without an unambiguous line", () => {
    expect(storedFulfillmentIdentity({ ebayOrderId: "13-14962-68653" })).toBeNull();
  });

  it("extracts carrier tracking from a redirected tracking page", () => {
    expect(trackingFromPage(
      "https://www.ups.com/track?tracknum=1Z999AA10123456784",
      "Package shipped with UPS",
    )).toEqual({ trackingNumber: "1Z999AA10123456784", carrier: "UPS" });
    expect(trackingFromPage(
      "https://www.amazon.com/progress-tracker/package",
      "Your package is out for delivery. Tracking ID: TBA123456789012 Amazon Logistics",
    )).toEqual({ trackingNumber: "TBA123456789012", carrier: "Amazon Logistics" });
  });

  it("does not mistake an Amazon order id for a carrier tracking number", () => {
    expect(trackingFromPage(
      "https://www.amazon.com/gp/your-account/ship-track?orderId=111-2222222-3333333",
      "Track package for order 111-2222222-3333333",
    )).toBeNull();
  });

  it("attributes split-shipment tracking only to ASINs named in the shipment email", () => {
    expect(trackingAppliesToAsin('["B0ABC12345"]', 3, "B0ABC12345")).toBe(true);
    expect(trackingAppliesToAsin('["B0ABC12345"]', 3, "B0OTHER123")).toBe(false);
    expect(trackingAppliesToAsin("[]", 1, "B0ABC12345")).toBe(true);
    expect(trackingAppliesToAsin("[]", 2, "B0ABC12345")).toBe(false);
  });
});
