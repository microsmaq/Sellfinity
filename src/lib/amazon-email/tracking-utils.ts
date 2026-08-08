export function normalizeTrackingNumber(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function ebayCarrierCode(carrier: string | null, trackingNumber: string): string {
  const normalized = (carrier ?? "").toLowerCase();
  if (normalized.includes("usps") || normalized.includes("postal")) return "USPS";
  if (normalized.includes("ups")) return "UPS";
  if (normalized.includes("fedex") || normalized.includes("fed ex")) return "FedEx";
  if (normalized.includes("dhl")) return "DHL";
  if (normalized.includes("ontrac")) return "ONTRACK";
  if (/^1Z/i.test(trackingNumber)) return "UPS";
  if (/^9\d{19,21}$/.test(trackingNumber)) return "USPS";
  return "Other";
}

export function remoteFulfillmentKey(orderId: string, lineItemId: string): string {
  return `${orderId}-${lineItemId}`;
}

export function trackingAppliesToAsin(trackingAsinsJson: string, purchaseItemCount: number, asin: string): boolean {
  try {
    const trackingAsins = JSON.parse(trackingAsinsJson) as unknown;
    if (Array.isArray(trackingAsins) && trackingAsins.every((value) => typeof value === "string") && trackingAsins.length > 0) {
      return trackingAsins.some((value) => value.toUpperCase() === asin.toUpperCase());
    }
  } catch { /* Fall back to the original single-item safety rule. */ }
  return purchaseItemCount === 1;
}
