import "server-only";
import { appAccessToken, ebayEnvConfig } from "./oauth";
import type { CountdownBestSellerSnapshot } from "./countdown";
import {
  mapBrowseBestSellerItems,
  type BrowseBestSellerItem,
} from "./browse-bestseller-map";

const SEARCH_LIMIT = 100;
const DETAIL_BATCH_SIZE = 20;

async function ebayJson<T>(url: string, token: string, stage: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as {
        errors?: { errorId?: number; message?: string; longMessage?: string }[];
      };
      const first = payload.errors?.[0];
      detail = [first?.errorId ? `eBay ${first.errorId}` : "", first?.message || first?.longMessage || ""]
        .filter(Boolean)
        .join(": ")
        .slice(0, 240);
    } catch {
      detail = "";
    }
    throw new Error(`eBay Browse ${stage} failed (${response.status})${detail ? `: ${detail}` : ". The eBay application may not have Production Buy API access."}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchEbayBrowseBestSellers(
  researchTerm: string,
): Promise<CountdownBestSellerSnapshot> {
  const config = ebayEnvConfig();
  if (!config) throw new Error("eBay Browse API is not configured.");
  const term = researchTerm.trim().slice(0, 120) || "electronics";
  const token = await appAccessToken(config);
  const searchParams = new URLSearchParams({
    q: term,
    limit: String(SEARCH_LIMIT),
    filter: "priceCurrency:USD,buyingOptions:{FIXED_PRICE}",
  });
  const search = await ebayJson<{
    total?: number;
    itemSummaries?: BrowseBestSellerItem[];
  }>(`${config.apiHost}/buy/browse/v1/item_summary/search?${searchParams}`, token, "search");
  const ids = (search.itemSummaries ?? [])
    .map((item) => item.itemId?.trim())
    .filter((itemId): itemId is string => Boolean(itemId));
  const detailed: BrowseBestSellerItem[] = [];
  for (let index = 0; index < ids.length; index += DETAIL_BATCH_SIZE) {
    const params = new URLSearchParams({
      item_ids: ids.slice(index, index + DETAIL_BATCH_SIZE).join(","),
    });
    const result = await ebayJson<{ items?: BrowseBestSellerItem[] }>(
      `${config.apiHost}/buy/browse/v1/item/?${params}`,
      token,
      "item-details batch",
    );
    detailed.push(...(result.items ?? []));
  }
  const items = mapBrowseBestSellerItems(detailed);
  return {
    capturedAt: new Date().toISOString(),
    researchTerm: term,
    items,
    totalResults: Number(search.total ?? ids.length),
    creditsUsed: 0,
    creditsRemaining: null,
    requestedResults: ids.length,
    fallbackUsed: true,
    sampledListings: detailed.length,
    provider: "EBAY_BROWSE",
  } as CountdownBestSellerSnapshot;
}
