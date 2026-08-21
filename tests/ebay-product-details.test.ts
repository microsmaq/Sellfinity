import { describe, expect, it } from "vitest";
import {
  EBAY_US_IDENTIFIER_UNAVAILABLE,
  ebayProductBrand,
  ebayProductMpn,
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
});
