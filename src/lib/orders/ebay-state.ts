export type ImportedOrderStatus = "PAID" | "SHIPPED" | "REFUNDED";

/** Convert eBay's order lifecycle fields into Sellfinity's stored state. */
export function ebayImportedOrderState(input: {
  cancelState?: string | null;
  paymentStatus?: string | null;
  fulfillmentStatus?: string | null;
}): { status: ImportedOrderStatus; cancelled: boolean } {
  const cancelState = input.cancelState?.trim().toUpperCase() ?? "";
  const paymentStatus = input.paymentStatus?.trim().toUpperCase() ?? "";
  const fulfillmentStatus = input.fulfillmentStatus?.trim().toUpperCase() ?? "";
  const cancelled = Boolean(cancelState && cancelState !== "NONE_REQUESTED");

  if (paymentStatus === "FULLY_REFUNDED") return { status: "REFUNDED", cancelled };
  if (fulfillmentStatus === "FULFILLED") return { status: "SHIPPED", cancelled };
  return { status: "PAID", cancelled };
}
