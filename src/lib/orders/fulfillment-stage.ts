export type FulfillmentStage =
  | "AWAITING"
  | "PURCHASED"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "CANCELLED"
  | "REFUNDED";

export type FulfillmentActionReason = "FULFILLMENT" | "TRACKING" | "PRICE_PROTECTION";

export type FulfillmentActionInput = {
  stage: FulfillmentStage;
  trackingNumber?: string | null;
  needsSource?: boolean;
  trackingError?: string | null;
  trackingNeedsSync?: boolean;
  protectionNeedsReview?: boolean;
  ebayFulfilled?: boolean;
};

export function fulfillmentActionReason(input: FulfillmentActionInput): FulfillmentActionReason | null {
  if (input.stage === "CANCELLED" || input.stage === "REFUNDED") return null;
  // eBay is the destination system for fulfillment. If it already considers
  // the line fulfilled, a missing local copy of its tracking number is not a
  // seller action. Refresh separately recovers that number when available.
  if (input.ebayFulfilled) {
    if (input.trackingError) return "TRACKING";
    return input.protectionNeedsReview ? "PRICE_PROTECTION" : null;
  }
  if (input.trackingError || input.trackingNeedsSync) return "TRACKING";
  if (!input.trackingNumber || input.stage === "AWAITING" || input.stage === "PURCHASED" || input.needsSource) {
    return "FULFILLMENT";
  }
  return input.protectionNeedsReview ? "PRICE_PROTECTION" : null;
}

export function fulfillmentNeedsAction(input: FulfillmentActionInput): boolean {
  return fulfillmentActionReason(input) !== null;
}

/** Prefer the linked Amazon purchase lifecycle over a stale local sourcing
 * status. A shipment or delivery badge also requires shipment evidence so an
 * order-confirmation match cannot appear delivered before Amazon ships it. */
export function fulfillmentStage(input: {
  ebayStatus: string;
  sourcingStatus: string;
  amazonPurchaseStatus?: string | null;
  hasShipmentDetails: boolean;
}): FulfillmentStage {
  const {
    ebayStatus,
    sourcingStatus,
    amazonPurchaseStatus,
    hasShipmentDetails,
  } = input;

  if (sourcingStatus === "CANCELLED" || amazonPurchaseStatus === "CANCELLED") {
    return "CANCELLED";
  }
  if (ebayStatus === "REFUNDED") return "REFUNDED";

  if (amazonPurchaseStatus === "DELIVERED" && hasShipmentDetails) return "DELIVERED";
  if (amazonPurchaseStatus === "SHIPPED" && hasShipmentDetails) return "IN_TRANSIT";
  // A purchase email can remain stale or omit shipment details after the
  // seller fulfilled the line directly on eBay. eBay's completed state is
  // independent shipment evidence.
  if (ebayStatus === "SHIPPED") return "IN_TRANSIT";
  if (amazonPurchaseStatus) return "PURCHASED";

  if (sourcingStatus === "DELIVERED") return "DELIVERED";
  if (sourcingStatus === "SHIPPED" || ebayStatus === "SHIPPED") return "IN_TRANSIT";
  if (sourcingStatus === "PURCHASED") return "PURCHASED";
  return "AWAITING";
}
