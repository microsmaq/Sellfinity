// String-enum values for SQLite-backed "enum" columns, plus JSON mappers.

export const LISTING_STATUSES = ["DRAFT", "ACTIVE", "ENDED"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const ORDER_STATUSES = ["PAID", "SHIPPED", "REFUNDED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SYNC_ISSUE_TYPES = [
  "OUT_OF_STOCK",
  "STOCK_DRIFT",
  "COST_RISE",
  "SUPPLIER_GONE",
] as const;
export type SyncIssueType = (typeof SYNC_ISSUE_TYPES)[number];

export const SYNC_RESOLUTIONS = ["OPEN", "AUTO_FIXED", "FIXED", "IGNORED"] as const;
export type SyncResolution = (typeof SYNC_RESOLUTIONS)[number];

export const EBAY_CONNECTION_STATUSES = ["DISCONNECTED", "SANDBOX", "CONNECTED"] as const;
export type EbayConnectionStatus = (typeof EBAY_CONNECTION_STATUSES)[number];

export function parseImageUrls(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function serializeImageUrls(urls: string[]): string {
  return JSON.stringify(urls);
}

// Details payload for a SyncIssue, stored as JSON.
export type SyncIssueDetails = {
  message: string;
  field?: "quantity" | "price";
  expected?: number; // what the listing should be (per supplier truth)
  actual?: number; // what the listing currently is
};

export function parseSyncIssueDetails(json: string): SyncIssueDetails {
  try {
    return JSON.parse(json) as SyncIssueDetails;
  } catch {
    return { message: "Unknown issue" };
  }
}
