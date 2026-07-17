export const LISTING_ACTIVITY_SOURCES = {
  URL_BULK: { label: "Amazon URLs", result: "Published", activity: false },
  ARBITRAGE: { label: "Arbitrage Finder", result: "Published", activity: false },
  LISTING_PUBLISH: { label: "Listing publish", result: "Published", activity: true },
  LISTING_EDIT: { label: "Listing edit", result: "Updated", activity: true },
  PRICE_OPTIMIZATION: { label: "Price optimization", result: "Updated", activity: true },
  AI_OPTIMIZATION: { label: "AI listing optimization", result: "Optimized", activity: true },
  LISTING_END: { label: "Listing ended", result: "Ended", activity: true },
  LISTING_SYNC: { label: "Listing sync", result: "Synced", activity: true },
} as const;

export type ListingActivitySource = keyof typeof LISTING_ACTIVITY_SOURCES;

export function batchSourceMeta(source: string): {
  label: string;
  result: string;
  activity: boolean;
} {
  return (
    LISTING_ACTIVITY_SOURCES[source as ListingActivitySource] ?? {
      label: source.replaceAll("_", " ").toLowerCase(),
      result: "Succeeded",
      activity: true,
    }
  );
}
