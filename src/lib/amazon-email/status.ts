export type AmazonPurchaseStatus = "ORDERED" | "SHIPPED" | "DELIVERED" | "CANCELLED";
export type OrderSourcingStatus = "PURCHASED" | "SHIPPED" | "DELIVERED" | "CANCELLED";

export function sourcingStatusForAmazonPurchase(status: string): OrderSourcingStatus {
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "SHIPPED") return "SHIPPED";
  return "PURCHASED";
}
