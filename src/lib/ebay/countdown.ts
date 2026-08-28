import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";
import { marketSearchQuery, summarizeBrowseMarket, type BrowseSummary } from "./market-analysis";
import type { EbayProductCandidate } from "./market";

const COUNTDOWN_ENDPOINT = "https://api.countdownapi.com/request";

type CountdownSearchResult = {
  title?: string;
  epid?: string;
  link?: string;
  image?: string;
  condition?: string;
  is_auction?: boolean;
  sponsored?: boolean;
  is_rewritten_result?: boolean;
  shipping_cost?: number;
  price?: { value?: number; currency?: string };
};

type CountdownSearchResponse = {
  request_info?: {
    success?: boolean;
    credits_used?: number;
    credits_remaining?: number;
    message?: string;
  };
  search_results?: CountdownSearchResult[];
  pagination?: {
    total_results?: number | string;
  };
};

export type CountdownAdminMarket = {
  query: string;
  metrics: ListingMarketMetrics;
  referencePriceCents: number | null;
};

export function countdownConfigured(): boolean {
  return Boolean(process.env.COUNTDOWN_API_KEY?.trim());
}

function numericListingId(result: CountdownSearchResult): string | null {
  const fromUrl = result.link?.match(/\/itm\/(?:[^/]+\/)?(\d{9,15})(?:[/?]|$)/)?.[1];
  const epid = result.epid?.trim();
  return fromUrl ?? (epid && /^\d{9,15}$/.test(epid) ? epid : null);
}

function landedPriceCents(result: CountdownSearchResult): number {
  const itemPrice = Number(result.price?.value ?? 0);
  const shipping = Number(result.shipping_cost ?? 0);
  return Math.round((itemPrice + Math.max(0, shipping)) * 100);
}

export function mapCountdownSearchResults(
  data: CountdownSearchResponse,
  limit = 50,
): { total: number; candidates: EbayProductCandidate[]; browseItems: BrowseSummary[] } {
  const usable = (data.search_results ?? [])
    .filter((result) => !result.is_auction && !result.is_rewritten_result)
    .flatMap((result) => {
      const itemId = numericListingId(result);
      const title = result.title?.trim();
      const priceCents = landedPriceCents(result);
      if (!itemId || !title || !result.link || priceCents <= 0) return [];
      return [{ result, itemId, title, priceCents }];
    })
    .slice(0, Math.max(1, Math.min(100, limit)));
  const candidates = usable.map(({ result, itemId, title, priceCents }) => ({
    itemId,
    title,
    priceCents,
    url: result.link!,
    imageUrl: result.image ?? "",
    category: "Other",
  }));
  const browseItems: BrowseSummary[] = usable.map(({ result, itemId, title, priceCents }) => ({
    itemId,
    title,
    price: { value: (priceCents / 100).toFixed(2) },
    itemWebUrl: result.link,
    image: result.image ? { imageUrl: result.image } : undefined,
  }));
  const rawTotal = Number(data.pagination?.total_results ?? usable.length);
  return {
    total: Number.isFinite(rawTotal) ? Math.max(usable.length, rawTotal) : usable.length,
    candidates,
    browseItems,
  };
}

async function countdownSearch(title: string, limit = 50): Promise<{
  query: string;
  total: number;
  candidates: EbayProductCandidate[];
  browseItems: BrowseSummary[];
}> {
  const apiKey = process.env.COUNTDOWN_API_KEY?.trim();
  if (!apiKey) throw new Error("Countdown API is not configured.");
  const query = marketSearchQuery(title);
  if (!query) return { query, total: 0, candidates: [], browseItems: [] };
  const params = new URLSearchParams({
    api_key: apiKey,
    type: "search",
    ebay_domain: "ebay.com",
    search_term: query,
    listing_type: "buy_it_now",
    condition: "new",
    allow_rewritten_results: "false",
    customer_location: "us",
    page: "1",
    output: "json",
  });
  const response = await fetch(`${COUNTDOWN_ENDPOINT}?${params}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Countdown eBay research failed (${response.status}).`);
  const data = await response.json() as CountdownSearchResponse;
  if (data.request_info?.success === false) {
    throw new Error(`Countdown eBay research failed: ${data.request_info.message?.slice(0, 180) || "provider rejected the request"}.`);
  }
  return { query, ...mapCountdownSearchResults(data, limit) };
}

export async function searchCountdownProducts(title: string, limit = 50): Promise<EbayProductCandidate[]> {
  return (await countdownSearch(title, limit)).candidates;
}

export async function researchCountdownMarket(
  title: string,
  referenceEbayListingId: string,
  options?: { allowReferenceFallback?: boolean },
): Promise<CountdownAdminMarket | null> {
  const data = await countdownSearch(title, 50);
  let metrics = summarizeBrowseMarket(data.total, data.browseItems, referenceEbayListingId, title);
  if (!metrics && options?.allowReferenceFallback) {
    metrics = summarizeBrowseMarket(data.total, data.browseItems, "__no_listing_excluded__", title);
  }
  if (!metrics) return null;
  const numericReference = referenceEbayListingId.includes("|")
    ? referenceEbayListingId.split("|")[1]
    : referenceEbayListingId;
  const reference = data.candidates.find((candidate) => candidate.itemId === numericReference);
  return {
    query: data.query,
    metrics,
    referencePriceCents: reference?.priceCents ?? null,
  };
}
