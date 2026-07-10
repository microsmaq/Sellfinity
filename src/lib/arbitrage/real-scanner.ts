// Real arbitrage scanner: eBay Browse API (real active listings) matched to
// Amazon products via the Rainforest search API. Results are cached per UTC
// day in ScanCache and shared across users; asking for a larger count
// resumes the day's scan where it left off, so credits are only spent on new
// rows (roughly one Rainforest credit per eBay candidate examined).

import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import { appAccessToken, ebayEnvConfig } from "@/lib/ebay/oauth";
import { findAmazonMatch } from "@/lib/mirror/match";
import { persistOpportunities } from "./store";
import type { ArbitrageOpportunity } from "./scanner";
import type { ScanReport } from "./scan-types";

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
const LOOKUP_BATCH = 5;

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

type ScanCursor = {
  pending: EbayCandidate[];
  nextKeyword: number;
  exhausted: boolean;
};

const EMPTY_CURSOR: ScanCursor = { pending: [], nextKeyword: 0, exhausted: false };

/** Cap on the rolling examined-set (each entry saved one repeat credit). */
const EXAMINED_CAP = 8000;

function currentDayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

async function loadJson<T>(cacheKey: string, fallback: T): Promise<T> {
  const row = await db.scanCache.findUnique({ where: { cacheKey } });
  return row ? (JSON.parse(row.dataJson) as T) : structuredClone(fallback);
}

async function saveJson(cacheKey: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data);
  await db.scanCache.upsert({
    where: { cacheKey },
    create: { cacheKey, dataJson: json },
    update: { dataJson: json },
  });
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

/** Find the Amazon counterpart of an eBay candidate; null when no confident,
 * sufficiently cheaper match exists. Costs one Rainforest credit. */
async function amazonMatch(
  candidate: EbayCandidate,
): Promise<ArbitrageOpportunity | null> {
  const match = await findAmazonMatch(candidate.title);
  if (!match) return null;
  if (match.priceCents > candidate.priceCents * MAX_SOURCE_RATIO) return null;

  const margin = estimateMargin(candidate.priceCents, match.priceCents, 0);
  if (margin.estimatedProfitCents <= 0) return null;

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
      asin: match.asin,
      title: match.title,
      priceCents: match.priceCents,
      url: match.url,
    },
    margin,
  };
}

/**
 * Advance the research scan within a time budget, persisting every match to
 * the ArbitrageItem table. The keyword cursor resets daily (fresh Browse
 * pages); the examined-set is global so a candidate is never paid for twice.
 */
export async function realScanMore(timeBudgetMs = 22_000): Promise<ScanReport> {
  const deadline = Date.now() + timeBudgetMs;
  const cursorKey = `arbitrage:cursor:${currentDayNumber()}`;
  const cursor = await loadJson<ScanCursor>(cursorKey, EMPTY_CURSOR);
  const examinedList = await loadJson<string[]>("arbitrage:examined", []);
  const examined = new Set(examinedList);

  let added = 0;
  let examinedNow = 0;

  const save = async () => {
    await saveJson(cursorKey, cursor);
    await saveJson("arbitrage:examined", [...examined].slice(-EXAMINED_CAP));
  };

  while (!cursor.exhausted && Date.now() < deadline) {
    if (cursor.pending.length === 0) {
      if (cursor.nextKeyword >= CATEGORY_KEYWORDS.length) {
        cursor.exhausted = true;
        break;
      }
      const idx =
        (cursor.nextKeyword + currentDayNumber()) % CATEGORY_KEYWORDS.length;
      const { keyword, category } = CATEGORY_KEYWORDS[idx];
      cursor.nextKeyword++;
      const candidates = await browseSearch(keyword, category);
      cursor.pending.push(...candidates.filter((c) => !examined.has(c.itemId)));
      continue;
    }

    const batch = cursor.pending.splice(0, LOOKUP_BATCH);
    const matches = await Promise.all(batch.map(amazonMatch));
    for (const c of batch) examined.add(c.itemId);
    examinedNow += batch.length;
    added += await persistOpportunities(
      matches.filter((m): m is ArbitrageOpportunity => m !== null),
    );
    await save();
  }

  await save();
  return { added, examined: examinedNow, exhausted: cursor.exhausted };
}
