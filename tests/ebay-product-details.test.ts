import { describe, expect, it } from "vitest";
import {
  EBAY_US_IDENTIFIER_UNAVAILABLE,
  ebayProductBrand,
  ebayProductMpn,
  extractEpaRegistrationNumber,
  hasPesticideClaims,
  requiredEbayAspectValue,
} from "@/lib/ebay/product-details";

describe("eBay product details", () => {
  it("preserves the Amazon brand for eBay product data", () => {
    expect(ebayProductBrand("  OFF!  ")).toBe("OFF!");
    expect(requiredEbayAspectValue("Brand", "ANCEL")).toBe("ANCEL");
  });

  it("uses marketplace fallbacks only when source data is unavailable", () => {
    expect(ebayProductBrand("unknown")).toBe("Unbranded");
    expect(ebayProductBrand("Does not apply")).toBe("Unbranded");
    expect(ebayProductBrand("")).toBe("Unbranded");
    expect(ebayProductMpn()).toBe(EBAY_US_IDENTIFIER_UNAVAILABLE);
    expect(ebayProductMpn("  ABC-123\u0000 ")).toBe("ABC-123");
    expect(requiredEbayAspectValue("UPC", "OFF!")).toBe(
      EBAY_US_IDENTIFIER_UNAVAILABLE,
    );
    expect(EBAY_US_IDENTIFIER_UNAVAILABLE).toBe("Does not apply");
  });

  it("never fabricates a required EPA registration number", () => {
    expect(requiredEbayAspectValue("EPA Registration Number", "Brand", "Kills insects")).toBeNull();
    expect(requiredEbayAspectValue("EPA Registration Number", "Brand", "EPA Reg. No. 12345-67-890")).toBe("12345-67-890");
    expect(extractEpaRegistrationNumber("EPA Registration Number: 777-12")).toBe("777-12");
  });

  it("recognizes regulated pesticide and disinfectant claims", () => {
    expect(hasPesticideClaims("Indoor insect repellent")).toBe(true);
    expect(hasPesticideClaims("Disinfecting surface cleaner")).toBe(true);
    expect(hasPesticideClaims("Cordless drill and battery")).toBe(false);
  });
});
