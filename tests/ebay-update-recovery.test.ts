import { describe, expect, it } from "vitest";
import {
  isAlreadyEndedEbayError,
  isInvalidEbayQuantityError,
  isMissingEbayInventoryProductError,
  isTransientEbaySystemError,
} from "@/lib/ebay/errors";

describe("eBay Smart Sync update recovery", () => {
  it("reconciles the ended-item revision response", () => {
    expect(isAlreadyEndedEbayError(
      'You are not allowed to revise an ended item "318593987443".',
    )).toBe(true);
  });

  it("recognizes an invalid Inventory quantity", () => {
    expect(isInvalidEbayQuantityError(
      'errorId:25004 AVAILABLE_QUANTITY must be greater than 0',
    )).toBe(true);
  });

  it("recognizes a retryable eBay system error", () => {
    expect(isTransientEbaySystemError(
      'failed (500): {"errorId":25001,"message":"A system error has occurred."}',
    )).toBe(true);
  });

  it("recognizes a detached Inventory SKU product", () => {
    expect(isMissingEbayInventoryProductError(
      "errorId:25604 Seller Inventory Service can not publish the data. Product not found.",
    )).toBe(true);
  });

  it("does not classify authentication failures as repairable", () => {
    const message = "Authentication token is invalid";
    expect(isAlreadyEndedEbayError(message)).toBe(false);
    expect(isInvalidEbayQuantityError(message)).toBe(false);
    expect(isTransientEbaySystemError(message)).toBe(false);
    expect(isMissingEbayInventoryProductError(message)).toBe(false);
  });
});
