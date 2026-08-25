import { describe, expect, it } from "vitest";
import {
  isAlreadyEndedEbayError,
  isInvalidEbayQuantityError,
  isMissingEbayInventoryProductError,
  isTransientEbaySystemError,
} from "@/lib/ebay/errors";
import { runEbayIdempotentUpdate } from "@/lib/ebay/recovery";

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
    const message = "failed (500): errorId:25604 Seller Inventory Service can not publish the data. Product not found.";
    expect(isMissingEbayInventoryProductError(message)).toBe(true);
    expect(isTransientEbaySystemError(message)).toBe(false);
  });

  it("recognizes a detached Inventory availability record", () => {
    expect(isMissingEbayInventoryProductError(
      "errorId:25604 Seller Inventory Service can not publish the data. Availability not found.",
    )).toBe(true);
  });

  it("retries transient eBay failures with exponential delays", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await runEbayIdempotentUpdate(async () => {
      calls++;
      if (calls < 3) throw new Error("errorId:25001 Core Inventory Service internal error");
      return "updated";
    }, {
      wait: async (delay) => { delays.push(delay); },
    });

    expect(result).toBe("updated");
    expect(calls).toBe(3);
    expect(delays).toEqual([600, 1200]);
  });

  it("does not retry eBay validation errors", async () => {
    let calls = 0;
    await expect(runEbayIdempotentUpdate(async () => {
      calls++;
      throw new Error("The UPC field is missing.");
    }, { wait: async () => undefined })).rejects.toThrow("UPC field is missing");
    expect(calls).toBe(1);
  });

  it("can retry missing availability briefly after rebuilding inventory", async () => {
    let calls = 0;
    const result = await runEbayIdempotentUpdate(async () => {
      calls++;
      if (calls === 1) throw new Error("errorId:25604 Availability not found");
      return "reconciled";
    }, {
      retryWhen: isMissingEbayInventoryProductError,
      wait: async () => undefined,
    });
    expect(result).toBe("reconciled");
    expect(calls).toBe(2);
  });

  it("does not classify authentication failures as repairable", () => {
    const message = "Authentication token is invalid";
    expect(isAlreadyEndedEbayError(message)).toBe(false);
    expect(isInvalidEbayQuantityError(message)).toBe(false);
    expect(isTransientEbaySystemError(message)).toBe(false);
    expect(isMissingEbayInventoryProductError(message)).toBe(false);
  });
});
