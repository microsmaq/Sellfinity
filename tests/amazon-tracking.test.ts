import { describe, expect, it } from "vitest";
import { ebayCarrierCode, normalizeTrackingNumber, remoteFulfillmentKey } from "@/lib/amazon-email/tracking-utils";

describe("Amazon tracking normalization", () => {
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
});
