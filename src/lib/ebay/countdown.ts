import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";
import { marketSearchQuery, summarizeBrowseMarket, type BrowseSummary } from "./market-analysis";
import type { EbayProductCandidate } from "./market";

const COUNTDOWN_ENDPOINT = "https://api.countdownapi.com/request";

type CountdownSearchResult = {
  position?: number;
  title?: string;
  epid?: string;
  link?: string;
  image?: string;
  condition?: string;
  hotness?: string;
  is_auction?: boolean;
  buy_it_now?: boolean;
  sponsored?: boolean;
  is_rewritten_result?: boolean;
  quantity_sold?: number | string;
  shipping_cost?: number;
  price?: { value?: number; currency?: string };
  seller_info?: {
    name?: string;
    review_count?: number;
    positive_feedback_percent?: number;
  };
  ended?: {
    type?: string;
    date?: { raw?: string };
  };
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

export type CountdownBestSeller = {
  itemId: string;
  title: string;
  url: string;
  imageUrl: string;
  priceCents: number;
  shippingCents: number;
  totalPriceCents: number;
  quantitySold: number;
  condition: string;
  sellerName: string;
  sellerFeedbackPct: number | null;
  sellerReviewCount: number | null;
  hotness: string;
  sponsored: boolean;
  endedType: string | null;
  endedDate: string | null;
  sourcePosition: number;
};

export type CountdownBestSellerSnapshot = {
  capturedAt: string;
  researchTerm: string;
  items: CountdownBestSeller[];
  totalResults: number;
  creditsUsed: number | null;
  creditsRemaining: number | null;
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

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/**
 * One-credit-efficient admin bestseller snapshot. `num=240` asks eBay for
 * the largest supported result page, then Sellfinity ranks the response by
 * eBay's reported cumulative quantity sold. Results are persisted by the
 * admin bestseller store; opening/filtering the page never calls Countdown.
 */
export async function fetchCountdownBestSellers(
  researchTerm = "",
): Promise<CountdownBestSellerSnapshot> {
  const apiKey = process.env.COUNTDOWN_API_KEY?.trim();
  if (!apiKey) throw new Error("Countdown API is not configured.");
  const term = researchTerm.trim().slice(0, 120);
  const params = new URLSearchParams({
    api_key: apiKey,
    type: "search",
    ebay_domain: "ebay.com",
    customer_location: "us",
    num: "240",
    output: "json",
    allow_rewritten_results: "false",
  });
  if (term) {
    params.set("search_term", term);
    params.set("sort_by", "best_match");
    params.set("listing_type", "buy_it_now");
    params.set("condition", "all");
  } else {
    // Countdown accepts an eBay search-results URL. A blank category-zero
    // search gives the widest single-call sample possible on a trial plan.
    params.set(
      "url",
      "https://www.ebay.com/sch/i.html?_nkw=&_sacat=0&LH_BIN=1&_sop=12",
    );
  }
  const response = await fetch(`${COUNTDOWN_ENDPOINT}?${params}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Countdown bestseller research failed (${response.status}).`);
  const data = await response.json() as CountdownSearchResponse;
  if (data.request_info?.success === false) {
    throw new Error(`Countdown bestseller research failed: ${data.request_info.message?.slice(0, 180) || "provider rejected the request"}.`);
  }
  return mapCountdownBestSellerResults(data, term);
}

export function mapCountdownBestSellerResults(
  data: CountdownSearchResponse,
  researchTerm = "",
  capturedAt = new Date().toISOString(),
): CountdownBestSellerSnapshot {
  const seen = new Set<string>();
  const items = (data.search_results ?? []).flatMap((result, index) => {
    if (result.is_auction || result.is_rewritten_result) return [];
    const itemId = numericListingId(result);
    const title = result.title?.trim();
    const priceCents = Math.round(finiteNonNegative(result.price?.value) * 100);
    if (!itemId || seen.has(itemId) || !title || !result.link || priceCents <= 0) return [];
    seen.add(itemId);
    const shippingCents = Math.round(finiteNonNegative(result.shipping_cost) * 100);
    const feedback = Number(result.seller_info?.positive_feedback_percent);
    const reviews = Number(result.seller_info?.review_count);
    return [{
      itemId,
      title,
      url: result.link,
      imageUrl: result.image ?? "",
      priceCents,
      shippingCents,
      totalPriceCents: priceCents + shippingCents,
      quantitySold: Math.floor(finiteNonNegative(result.quantity_sold)),
      condition: result.condition?.trim() || "Not specified",
      sellerName: result.seller_info?.name?.trim() || "Unknown seller",
      sellerFeedbackPct: Number.isFinite(feedback) ? feedback : null,
      sellerReviewCount: Number.isFinite(reviews) ? Math.max(0, Math.floor(reviews)) : null,
      hotness: result.hotness?.trim() || "",
      sponsored: Boolean(result.sponsored),
      endedType: result.ended?.type?.trim() || null,
      endedDate: result.ended?.date?.raw?.trim() || null,
      sourcePosition: result.position ?? index + 1,
    } satisfies CountdownBestSeller];
  }).sort((a, b) => b.quantitySold - a.quantitySold || a.sourcePosition - b.sourcePosition);
  const total = Number(data.pagination?.total_results ?? items.length);
  const used = Number(data.request_info?.credits_used);
  const remaining = Number(data.request_info?.credits_remaining);
  return {
    capturedAt,
    researchTerm: researchTerm.trim().slice(0, 120),
    items,
    totalResults: Number.isFinite(total) ? total : items.length,
    creditsUsed: Number.isFinite(used) ? used : null,
    creditsRemaining: Number.isFinite(remaining) ? remaining : null,
  };
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
