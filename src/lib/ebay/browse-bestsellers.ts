import "server-only";
import { appAccessToken, ebayEnvConfig } from "./oauth";
import type { CountdownBestSellerSnapshot } from "./countdown";
import {
  mapBrowseBestSellerItems,
  type BrowseBestSellerItem,
} from "./browse-bestseller-map";

export const BROWSE_BESTSELLER_PAGE_SIZE = 40;
const DETAIL_BATCH_SIZE = 20;
const INDIVIDUAL_DETAIL_LIMIT = 40;
const INDIVIDUAL_CONCURRENCY = 5;

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
  offset = 0,
  categoryId?: string,
  categoryLabel?: string,
): Promise<CountdownBestSellerSnapshot> {
  const config = ebayEnvConfig();
  if (!config) throw new Error("eBay Browse API is not configured.");
  const term = researchTerm.trim().slice(0, 120) || "electronics";
  const token = await appAccessToken(config);
  const normalizedOffset = Math.max(
    0,
    Math.floor(offset / BROWSE_BESTSELLER_PAGE_SIZE) * BROWSE_BESTSELLER_PAGE_SIZE,
  );
  const searchParams = new URLSearchParams({
    q: term,
    limit: String(BROWSE_BESTSELLER_PAGE_SIZE),
    offset: String(normalizedOffset),
    filter: "priceCurrency:USD,buyingOptions:{FIXED_PRICE}",
  });
  if (categoryId) searchParams.set("category_ids", categoryId);
  const search = await ebayJson<{
    total?: number;
    itemSummaries?: BrowseBestSellerItem[];
  }>(`${config.apiHost}/buy/browse/v1/item_summary/search?${searchParams}`, token, "search");
  const ids = (search.itemSummaries ?? [])
    .map((item) => item.itemId?.trim())
    .filter((itemId): itemId is string => Boolean(itemId));
  let detailed: BrowseBestSellerItem[] = [];
  let batchAccessDenied = false;
  for (let index = 0; index < ids.length; index += DETAIL_BATCH_SIZE) {
    const params = new URLSearchParams({
      item_ids: ids.slice(index, index + DETAIL_BATCH_SIZE).join(","),
    });
    try {
      const result = await ebayJson<{ items?: BrowseBestSellerItem[] }>(
        `${config.apiHost}/buy/browse/v1/item/?${params}`,
        token,
        "item-details batch",
      );
      detailed.push(...(result.items ?? []));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/item-details batch failed \(403\).*\b1100\b/i.test(message)) {
        batchAccessDenied = true;
        detailed = [];
        break;
      }
      throw error;
    }
  }
  if (batchAccessDenied) {
    // Some eBay applications can search and call getItem but are denied the
    // bulk getItems method. Limit and cache individual calls to protect the
    // application's daily Browse quota.
    const individualIds = ids.slice(0, INDIVIDUAL_DETAIL_LIMIT);
    let firstFailure: Error | null = null;
    for (let index = 0; index < individualIds.length; index += INDIVIDUAL_CONCURRENCY) {
      const group = await Promise.allSettled(
        individualIds.slice(index, index + INDIVIDUAL_CONCURRENCY).map((itemId) =>
          ebayJson<BrowseBestSellerItem>(
            `${config.apiHost}/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
            token,
            "single-item details",
          ),
        ),
      );
      for (const result of group) {
        if (result.status === "fulfilled") detailed.push(result.value);
        else if (!firstFailure) firstFailure = result.reason instanceof Error
          ? result.reason
          : new Error("eBay single-item details failed.");
      }
    }
    if (detailed.length === 0 && firstFailure) throw firstFailure;
  }
  const items = mapBrowseBestSellerItems(detailed).map((item, index) => ({
    ...item,
    sourcePosition: normalizedOffset + index + 1,
  }));
  const inspectedCount = batchAccessDenied ? Math.min(ids.length, INDIVIDUAL_DETAIL_LIMIT) : ids.length;
  const totalResults = Number(search.total ?? ids.length);
  return {
    capturedAt: new Date().toISOString(),
    researchTerm: term,
    items,
    totalResults,
    creditsUsed: 0,
    creditsRemaining: null,
    requestedResults: inspectedCount,
    fallbackUsed: true,
    sampledListings: detailed.length,
    provider: "EBAY_BROWSE",
    providerDetailMode: batchAccessDenied ? "INDIVIDUAL" : "BATCH",
    searchOffset: normalizedOffset,
    lastBatchSampledListings: detailed.length,
    hasMoreResults: normalizedOffset + inspectedCount < Math.min(10_000, totalResults),
    categoryId,
    categoryLabel,
  } as CountdownBestSellerSnapshot;
}
