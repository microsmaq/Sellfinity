import { describe, expect, it } from "vitest";
import { deliveryAddressFingerprint } from "@/lib/amazon-email/address-match";

describe("Amazon and eBay delivery address matching", () => {
  it("normalizes common street and apartment wording", () => {
    expect(deliveryAddressFingerprint("123 Main Street Apartment 4", "90001-1234"))
      .toBe(deliveryAddressFingerprint("123 Main St Apt 4", "90001"));
  });

  it("does not produce a fingerprint from incomplete addresses", () => {
    expect(deliveryAddressFingerprint("123 Main St", null)).toBeNull();
  });
});
