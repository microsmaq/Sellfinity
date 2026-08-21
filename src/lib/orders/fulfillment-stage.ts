export type FulfillmentStage =
  | "AWAITING"
  | "PURCHASED"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "CANCELLED"
  | "REFUNDED";

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

  if (amazonPurchaseStatus) {
    if (amazonPurchaseStatus === "DELIVERED") {
      return hasShipmentDetails ? "DELIVERED" : "PURCHASED";
    }
    if (amazonPurchaseStatus === "SHIPPED") {
      return hasShipmentDetails ? "IN_TRANSIT" : "PURCHASED";
    }
    return "PURCHASED";
  }

  if (sourcingStatus === "DELIVERED") return "DELIVERED";
  if (sourcingStatus === "SHIPPED" || ebayStatus === "SHIPPED") return "IN_TRANSIT";
  if (sourcingStatus === "PURCHASED") return "PURCHASED";
  return "AWAITING";
}
