import { describe, expect, it } from "vitest";
import { ebayImportedOrderState } from "@/lib/orders/ebay-state";

describe("ebayImportedOrderState", () => {
  it("marks any requested or completed cancellation as non-fulfillable", () => {
    expect(ebayImportedOrderState({ cancelState: "CANCEL_REQUESTED" })).toEqual({
      status: "PAID",
      cancelled: true,
    });
    expect(ebayImportedOrderState({ cancelState: "CANCEL_CLOSED" })).toEqual({
      status: "PAID",
      cancelled: true,
    });
  });

  it("keeps NONE_REQUESTED orders active", () => {
    expect(ebayImportedOrderState({ cancelState: "NONE_REQUESTED" })).toEqual({
      status: "PAID",
      cancelled: false,
    });
  });

  it("preserves refund and fulfillment state alongside cancellation", () => {
    expect(ebayImportedOrderState({ paymentStatus: "FULLY_REFUNDED", cancelState: "CANCEL_CLOSED" })).toEqual({
      status: "REFUNDED",
      cancelled: true,
    });
    expect(ebayImportedOrderState({ fulfillmentStatus: "FULFILLED" })).toEqual({
      status: "SHIPPED",
      cancelled: false,
    });
  });
});
