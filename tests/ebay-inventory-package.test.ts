import { describe, expect, it } from "vitest";
import { isInvalidEbayWeightError } from "@/lib/ebay/errors";
import { sanitizeEbayPackageWeightAndSize } from "@/lib/ebay/inventory-package";

describe("sanitizeEbayPackageWeightAndSize", () => {
  it("preserves a valid positive package weight", () => {
    expect(sanitizeEbayPackageWeightAndSize({
      packageType: "MAILING_BOX",
      weight: { value: "2.5", unit: "pound" },
    })).toEqual({
      packageType: "MAILING_BOX",
      weight: { value: "2.5", unit: "POUND" },
    });
  });

  it.each([0, -1, "", "not-a-number", null])(
    "removes invalid weight value %s while preserving other package data",
    (value) => {
      expect(sanitizeEbayPackageWeightAndSize({
        packageType: "MAILING_BOX",
        weight: { value, unit: "POUND" },
      })).toEqual({ packageType: "MAILING_BOX" });
    },
  );

  it("removes a weight with an unsupported unit", () => {
    expect(sanitizeEbayPackageWeightAndSize({
      shippingIrregular: false,
      weight: { value: 2, unit: "STONE" },
    })).toEqual({ shippingIrregular: false });
  });

  it("omits an empty package container after removing its invalid weight", () => {
    expect(sanitizeEbayPackageWeightAndSize({
      weight: { value: 0, unit: "POUND" },
    })).toBeUndefined();
  });
});

describe("isInvalidEbayWeightError", () => {
  it("recognizes eBay's package weight validation response", () => {
    expect(isInvalidEbayWeightError(
      'eBay PUT failed (400): {"errors":[{"errorId":25709,"message":"Invalid value for weight.value."}]}',
    )).toBe(true);
  });
});
