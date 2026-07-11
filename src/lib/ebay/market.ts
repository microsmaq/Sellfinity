import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";
import { appAccessToken, ebayEnvConfig } from "./oauth";
import {
  marketSearchQuery,
  summarizeBrowseMarket,
  type BrowseSummary,
} from "./market-analysis";

export async function researchEbayMarket(
  title: string,
  ownEbayListingId: string,
): Promise<{ query: string; metrics: ListingMarketMetrics } | null> {
  const config = ebayEnvConfig();
  if (!config) return null;
  const query = marketSearchQuery(title);
  if (!query) return null;
  const token = await appAccessToken(config);
  const params = new URLSearchParams({
    q: query,
    limit: "50",
    filter: "priceCurrency:USD,buyingOptions:{FIXED_PRICE}",
  });
  const response = await fetch(
    `${config.apiHost}/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    },
  );
  if (!response.ok) throw new Error(`eBay market search failed (${response.status})`);
  const data = (await response.json()) as {
    total?: number;
    itemSummaries?: BrowseSummary[];
  };
  const metrics = summarizeBrowseMarket(
    data.total ?? 0,
    data.itemSummaries ?? [],
    ownEbayListingId,
  );
  return metrics ? { query, metrics } : null;
}
