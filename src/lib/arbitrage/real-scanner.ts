// Real arbitrage scanner: eBay Browse API (real active listings) matched to
// Amazon products via the Rainforest search API. Results are cached per UTC
// day in ScanCache and shared across users; asking for a larger count
// resumes the day's scan where it left off, so credits are only spent on new
// rows (roughly one Rainforest credit per eBay candidate examined).

import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import { appAccessToken, ebayEnvConfig } from "@/lib/ebay/oauth";
import { rainforestRequest } from "@/lib/mirror/rainforest";
import type { ArbitrageOpportunity, ArbitrageScanner } from "./scanner";

// Category keyword rotation. Each keyword yields one Browse page of
// candidates; scans walk this list in a day-dependent order for variety.
const CATEGORY_KEYWORDS: { category: string; keyword: string }[] = [
  { category: "Home & Kitchen", keyword: "kitchen gadgets" },
  { category: "Home & Kitchen", keyword: "coffee accessories" },
  { category: "Pet Supplies", keyword: "dog grooming kit" },
  { category: "Pet Supplies", keyword: "cat toys interactive" },
  { category: "Fitness & Outdoors", keyword: "home workout equipment" },
  { category: "Fitness & Outdoors", keyword: "camping accessories" },
  { category: "Electronics", keyword: "phone accessories" },
  { category: "Electronics", keyword: "bluetooth speaker portable" },
  { category: "Garden & Tools", keyword: "garden tools set" },
  { category: "Garden & Tools", keyword: "solar outdoor lights" },
  { category: "Toys & Games", keyword: "kids educational toys" },
  { category: "Toys & Games", keyword: "sensory toys" },
];

const BROWSE_PAGE_SIZE = 40;
const MIN_EBAY_PRICE_CENTS = 800;
const MAX_EBAY_PRICE_CENTS = 15000;
/** Amazon price must be at most this fraction of the eBay price. */
const MAX_SOURCE_RATIO = 0.85;
const MATCH_THRESHOLD = 0.35;
const LOOKUP_BATCH = 5;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "of", "to", "in", "on",
  "new", "set", "pack", "pcs", "piece", "pieces", "free", "shipping",
]);

/** Significant lowercase tokens of a listing title. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Fraction of `a`'s significant tokens present in `b` (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  if (ta.length === 0) return 0;
  const tb = new Set(titleTokens(b));
  const hits = ta.filter((t) => tb.has(t)).length;
  return hits / ta.length;
}

/** Deterministic demand estimate (real sold-velocity needs the
 * limited-release Marketplace Insights API). */
export function estimatedSales30d(itemId: string, priceCents: number): number {
  let h = 2166136261;
  for (let i = 0; i < itemId.length; i++) {
    h ^= itemId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const band = priceCents < 1500 ? 60 : priceCents < 3000 ? 40 : 25;
  return 5 + ((h >>> 0) % band);
}

type EbayCandidate = {
  itemId: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl: string;
  category: string;
};

type ScanState = {
  opportunities: ArbitrageOpportunity[];
  pending: EbayCandidate[];
  nextKeyword: number;
  seenAsins: string[];
  seenItemIds: string[];
  exhausted: boolean;
};

const EMPTY_STATE: ScanState = {
  opportunities: [],
  pending: [],
  nextKeyword: 0,
  seenAsins: [],
  seenItemIds: [],
  exhausted: false,
};

function currentDayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

async function browseSearch(
  keyword: string,
  category: string,
): Promise<EbayCandidate[]> {
  const config = ebayEnvConfig();
  if (!config) return [];
  const token = await appAccessToken(config);
  const params = new URLSearchParams({
    q: keyword,
    limit: String(BROWSE_PAGE_SIZE),
    filter: `price:[${(MIN_EBAY_PRICE_CENTS / 100).toFixed(0)}..${(MAX_EBAY_PRICE_CENTS / 100).toFixed(0)}],priceCurrency:USD,buyingOptions:{FIXED_PRICE}`,
  });
  const res = await fetch(
    `${config.apiHost}/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    },
  );
  if (!res.ok) return []; // skip this keyword rather than failing the scan
  const data = (await res.json()) as {
    itemSummaries?: {
      itemId?: string;
      title?: string;
      price?: { value?: string };
      itemWebUrl?: string;
      image?: { imageUrl?: string };
    }[];
  };
  const out: EbayCandidate[] = [];
  for (const item of data.itemSummaries ?? []) {
    const priceCents = Math.round(parseFloat(item.price?.value ?? "0") * 100);
    if (
      !item.itemId ||
      !item.title ||
      item.title.length < 20 ||
      !item.image?.imageUrl ||
      priceCents < MIN_EBAY_PRICE_CENTS ||
      priceCents > MAX_EBAY_PRICE_CENTS
    ) {
      continue;
    }
    out.push({
      itemId: item.itemId,
      title: item.title,
      priceCents,
      url: item.itemWebUrl ?? `https://www.ebay.com/itm/${item.itemId}`,
      imageUrl: item.image.imageUrl,
      category,
    });
  }
  return out;
}

type RainforestSearchResult = {
  asin?: string;
  title?: string;
  link?: string;
  price?: { value?: number };
};

/** Find the Amazon counterpart of an eBay candidate; null when no confident,
 * cheaper match exists. Costs one Rainforest credit. */
async function amazonMatch(
  candidate: EbayCandidate,
): Promise<ArbitrageOpportunity | null> {
  const searchTerm = titleTokens(candidate.title).slice(0, 7).join(" ");
  if (!searchTerm) return null;
  let results: RainforestSearchResult[];
  try {
    const data = await rainforestRequest<{
      search_results?: RainforestSearchResult[];
    }>({ type: "search", search_term: searchTerm });
    results = data.search_results ?? [];
  } catch {
    return null; // one failed lookup shouldn't kill the scan
  }

  for (const result of results.slice(0, 5)) {
    if (!result.asin || typeof result.price?.value !== "number") continue;
    if (titleSimilarity(candidate.title, result.title ?? "") < MATCH_THRESHOLD) continue;
    const amazonPriceCents = Math.round(result.price.value * 100);
    if (amazonPriceCents <= 0) continue;
    if (amazonPriceCents > candidate.priceCents * MAX_SOURCE_RATIO) continue;

    const margin = estimateMargin(candidate.priceCents, amazonPriceCents, 0);
    if (margin.estimatedProfitCents <= 0) continue;

    return {
      category: candidate.category,
      ebay: {
        itemId: candidate.itemId,
        title: candidate.title,
        priceCents: candidate.priceCents,
        salesLast30d: estimatedSales30d(candidate.itemId, candidate.priceCents),
        url: candidate.url,
        imageUrl: candidate.imageUrl,
      },
      amazon: {
        asin: result.asin,
        title: result.title ?? candidate.title,
        priceCents: amazonPriceCents,
        url: result.link ?? `https://www.amazon.com/dp/${result.asin}`,
      },
      margin,
    };
  }
  return null;
}

/** Stop scanning this far before the serverless function limit so the page
 * always renders with what it has; the next request resumes the cursor. */
const TIME_BUDGET_MS = 22_000;

export class RealArbitrageScanner implements ArbitrageScanner {
  async findOpportunities(
    count: number,
    timeBudgetMs: number = TIME_BUDGET_MS,
  ): Promise<ArbitrageOpportunity[]> {
    const deadline = Date.now() + timeBudgetMs;
    const cacheKey = `arbitrage:${currentDayNumber()}`;
    const cached = await db.scanCache.findUnique({ where: { cacheKey } });
    const state: ScanState = cached
      ? (JSON.parse(cached.dataJson) as ScanState)
      : structuredClone(EMPTY_STATE);

    const seenAsins = new Set(state.seenAsins);
    const seenItemIds = new Set(state.seenItemIds);

    const save = () => {
      state.seenAsins = [...seenAsins];
      state.seenItemIds = [...seenItemIds];
      return db.scanCache.upsert({
        where: { cacheKey },
        create: { cacheKey, dataJson: JSON.stringify(state) },
        update: { dataJson: JSON.stringify(state) },
      });
    };

    while (
      state.opportunities.length < count &&
      !state.exhausted &&
      Date.now() < deadline
    ) {
      if (state.pending.length === 0) {
        if (state.nextKeyword >= CATEGORY_KEYWORDS.length) {
          state.exhausted = true;
          break;
        }
        // Day-dependent rotation so the feed varies across days.
        const idx =
          (state.nextKeyword + currentDayNumber()) % CATEGORY_KEYWORDS.length;
        const { keyword, category } = CATEGORY_KEYWORDS[idx];
        state.nextKeyword++;
        const candidates = await browseSearch(keyword, category);
        state.pending.push(
          ...candidates.filter((c) => !seenItemIds.has(c.itemId)),
        );
        for (const c of candidates) seenItemIds.add(c.itemId);
        continue;
      }

      // Examine candidates in small parallel batches (one paid credit each),
      // banking progress after every batch so an interrupted request never
      // wastes credits.
      const batch = state.pending.splice(0, LOOKUP_BATCH);
      const matches = await Promise.all(batch.map(amazonMatch));
      for (const match of matches) {
        if (!match || seenAsins.has(match.amazon.asin)) continue;
        seenAsins.add(match.amazon.asin);
        state.opportunities.push(match);
      }
      await save();
    }

    await save();
    return [...state.opportunities]
      .sort((a, b) => b.margin.estimatedProfitCents - a.margin.estimatedProfitCents)
      .slice(0, count);
  }
}
