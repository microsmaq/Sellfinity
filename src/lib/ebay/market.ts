import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";
import { appAccessToken, ebayEnvConfig } from "./oauth";
import {
  marketSearchQuery,
  summarizeBrowseMarket,
  type BrowseSummary,
} from "./market-analysis";

export type EbayProductCandidate = {
  itemId: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl: string;
  category: string;
};

async function browseSearch(title: string, limit = 50): Promise<{
  total: number;
  items: BrowseSummary[];
}> {
  const config = ebayEnvConfig();
  if (!config) return { total: 0, items: [] };
  const query = marketSearchQuery(title);
  if (!query) return { total: 0, items: [] };
  const token = await appAccessToken(config);
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.max(1, Math.min(200, limit))),
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
  return { total: data.total ?? 0, items: data.itemSummaries ?? [] };
}

/** Candidate listings for attaching an eBay market to an Amazon-first
 * administrative catalog row. Identity verification is deliberately left to
 * the caller because title and image evidence both matter. */
export async function searchEbayProducts(
  amazonTitle: string,
  limit = 50,
): Promise<EbayProductCandidate[]> {
  const { items } = await browseSearch(amazonTitle, limit);
  return items.flatMap((item) => {
    const priceCents = Math.round(Number(item.price?.value ?? 0) * 100);
    if (!item.itemId || !item.title || priceCents <= 0) return [];
    const numericId = item.itemId.includes("|")
      ? item.itemId.split("|")[1]
      : item.itemId;
    return [{
      itemId: item.itemId,
      title: item.title,
      priceCents,
      url: item.itemWebUrl ?? `https://www.ebay.com/itm/${numericId}`,
      imageUrl: item.image?.imageUrl ?? "",
      category: item.categories?.[0]?.categoryName ?? "Other",
    }];
  });
}

export async function researchEbayMarket(
  title: string,
  ownEbayListingId: string,
  options?: { allowReferenceFallback?: boolean },
): Promise<{
  query: string;
  metrics: ListingMarketMetrics;
  referencePriceCents: number | null;
} | null> {
  const query = marketSearchQuery(title);
  if (!query) return null;
  const data = await browseSearch(title, 50);
  let metrics = summarizeBrowseMarket(
    data.total,
    data.items,
    ownEbayListingId,
    title,
  );
  // Administrative catalog rows point at a competitor/reference listing, not
  // the signed-in seller's own offer. If that is the only precise search
  // result, it remains a valid market signal and should not leave every metric
  // blank. Seller-listing research keeps the stricter default.
  if (!metrics && options?.allowReferenceFallback) {
    metrics = summarizeBrowseMarket(
      data.total,
      data.items,
      "__no_listing_excluded__",
      title,
    );
  }
  const ownNumericId = ownEbayListingId.includes("|")
    ? ownEbayListingId.split("|")[1]
    : ownEbayListingId;
  const reference = data.items.find((item) => {
    if (!item.itemId) return false;
    const candidateNumericId = item.itemId.includes("|")
      ? item.itemId.split("|")[1]
      : item.itemId;
    return candidateNumericId === ownNumericId;
  });
  const referencePriceCents = Math.round(
    Number(reference?.price?.value ?? 0) * 100,
  );
  return metrics
    ? {
        query,
        metrics,
        referencePriceCents:
          referencePriceCents > 0 ? referencePriceCents : null,
      }
    : null;
}
