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

export function amazonStatusCanUploadTracking(status: string): boolean {
  return status === "SHIPPED" || status === "DELIVERED";
}

export function trackingCandidateForUpload(input: {
  storedTrackingNumber?: string | null;
  storedCarrier?: string | null;
  amazonTrackingNumber?: string | null;
  amazonCarrier?: string | null;
  amazonStatus?: string | null;
  amazonAttributionSafe: boolean;
}): { trackingNumber: string; carrier: string | null } | null {
  if (input.storedTrackingNumber) {
    return { trackingNumber: input.storedTrackingNumber, carrier: input.storedCarrier ?? input.amazonCarrier ?? null };
  }
  if (!input.amazonTrackingNumber || !input.amazonStatus || !amazonStatusCanUploadTracking(input.amazonStatus) || !input.amazonAttributionSafe) return null;
  return { trackingNumber: input.amazonTrackingNumber, carrier: input.amazonCarrier ?? null };
}

/** New imports use order+line identity. Older single-line imports stored only
 * eBay's order id, so expose that alias only when it cannot be ambiguous. */
export function remoteFulfillmentLookupKeys(orderId: string, lineItemId: string, lineCount: number): string[] {
  const composite = remoteFulfillmentKey(orderId, lineItemId);
  return lineCount === 1 ? [composite, orderId] : [composite];
}

/** Resolve the REST Fulfillment API identifiers retained in a locally stored
 * order. Current imports store checkoutOrderId separately; older imports used
 * the composite `<checkout order>-<line item>` value as ebayOrderId. */
export function storedFulfillmentIdentity(input: {
  ebayOrderId: string;
  ebayCheckoutOrderId?: string | null;
}): { orderId: string; lineItemId: string } | null {
  const checkoutOrderId = input.ebayCheckoutOrderId?.trim();
  if (checkoutOrderId) {
    const prefix = `${checkoutOrderId}-`;
    if (!input.ebayOrderId.startsWith(prefix)) return null;
    const lineItemId = input.ebayOrderId.slice(prefix.length).trim();
    return lineItemId ? { orderId: checkoutOrderId, lineItemId } : null;
  }
  const legacyComposite = input.ebayOrderId.match(/^(\d{2}-\d{5}-\d{5})-(\d+)$/);
  return legacyComposite
    ? { orderId: legacyComposite[1], lineItemId: legacyComposite[2] }
    : null;
}

export function trackingUploadErrorDisposition(message: string): "ALREADY_SHIPPED" | "RETRYABLE" | "FAILED" {
  if (/32320|tracking number already used[\s\S]*marked as shipped/i.test(message)) return "ALREADY_SHIPPED";
  if (/\b30500\b|\(500\)|system error/i.test(message)) return "RETRYABLE";
  return "FAILED";
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
