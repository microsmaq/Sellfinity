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
export { estimatedSales30d } from "./demand";
import { estimatedSales30d } from "./demand";
import { assessProductMatch, isApprovedProductMatch } from "./product-match";

// Category keyword rotation. Each keyword yields one Browse page of
// candidates; scans walk this list in a day-dependent order for variety.
const CATEGORY_KEYWORDS: { category: string; keyword: string }[] = [
  { category: "Home & Kitchen", keyword: "kitchen gadgets" },
  { category: "Home & Kitchen", keyword: "coffee accessories" },
  { category: "Home & Kitchen", keyword: "air fryer accessories" },
  { category: "Home & Kitchen", keyword: "kitchen organization" },
  { category: "Home & Kitchen", keyword: "baking tools" },
  { category: "Pet Supplies", keyword: "dog grooming kit" },
  { category: "Pet Supplies", keyword: "cat toys interactive" },
  { category: "Pet Supplies", keyword: "dog training supplies" },
  { category: "Pet Supplies", keyword: "pet travel accessories" },
  { category: "Fitness & Outdoors", keyword: "home workout equipment" },
  { category: "Fitness & Outdoors", keyword: "camping accessories" },
  { category: "Fitness & Outdoors", keyword: "resistance bands set" },
  { category: "Fitness & Outdoors", keyword: "hiking gear" },
  { category: "Fitness & Outdoors", keyword: "yoga accessories" },
  { category: "Electronics", keyword: "phone accessories" },
  { category: "Electronics", keyword: "bluetooth speaker portable" },
  { category: "Electronics", keyword: "wireless charger stand" },
  { category: "Electronics", keyword: "car accessories electronics" },
  { category: "Electronics", keyword: "led strip lights" },
  { category: "Garden & Tools", keyword: "garden tools set" },
  { category: "Garden & Tools", keyword: "solar outdoor lights" },
  { category: "Garden & Tools", keyword: "plant care tools" },
  { category: "Garden & Tools", keyword: "outdoor patio decor" },
  { category: "Toys & Games", keyword: "kids educational toys" },
  { category: "Toys & Games", keyword: "sensory toys" },
  { category: "Toys & Games", keyword: "building blocks toys" },
  { category: "Toys & Games", keyword: "party games kids" },
  { category: "Home Improvement", keyword: "bathroom organizer" },
  { category: "Home Improvement", keyword: "wall mounted shelf" },
  { category: "Beauty & Health", keyword: "massage tools" },
];

const BROWSE_PAGE_SIZE = 40;
/** How deep to paginate each keyword's Browse results. */
const MAX_PAGES_PER_KEYWORD = 5;
const MIN_EBAY_PRICE_CENTS = 800;
const MAX_EBAY_PRICE_CENTS = 15000;
const LOOKUP_BATCH = 5;

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
  keywordIdx: number;
  pageOffset: number;
  exhausted: boolean;
};

const EMPTY_CURSOR: ScanCursor = {
  pending: [],
  keywordIdx: 0,
  pageOffset: 0,
  exhausted: false,
};

/** Cap on the rolling examined-set (each entry saved one repeat credit). */
const EXAMINED_CAP = 20000;

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
  offset = 0,
): Promise<EbayCandidate[]> {
  const config = ebayEnvConfig();
  if (!config) return [];
  const token = await appAccessToken(config);
  const params = new URLSearchParams({
    q: keyword,
    limit: String(BROWSE_PAGE_SIZE),
    offset: String(offset),
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
  // Break-even and better both qualify: the Amazon source just can't cost
  // more than the eBay comp — the seller adds their margin at publish time.
  if (match.priceCents > candidate.priceCents) return null;

  const assessment = await assessProductMatch(
    { title: candidate.title, imageUrl: candidate.imageUrl },
    { title: match.title, imageUrl: match.imageUrl },
  );
  if (!isApprovedProductMatch(assessment)) return null;

  const margin = estimateMargin(candidate.priceCents, match.priceCents, 0);

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
    match: assessment,
  };
}

/**
 * Advance the research scan until `target` NEW items are added (or all of
 * today's sources are exhausted), within a per-request time budget — callers
 * loop requests to finish the target. Every match is persisted immediately;
 * the examined-set is global so no candidate lookup is ever paid for twice.
 */
export async function realScanMore(opts: {
  target?: number;
  timeBudgetMs?: number;
} = {}): Promise<ScanReport> {
  const target = opts.target ?? 50;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 22_000);
  const cursorKey = `arbitrage:cursor2:${currentDayNumber()}`;
  const cursor = await loadJson<ScanCursor>(cursorKey, EMPTY_CURSOR);
  const examinedList = await loadJson<string[]>("arbitrage:examined", []);
  const examined = new Set(examinedList);

  let added = 0;
  let examinedNow = 0;

  const save = async () => {
    await saveJson(cursorKey, cursor);
    await saveJson("arbitrage:examined", [...examined].slice(-EXAMINED_CAP));
  };

  while (added < target && !cursor.exhausted && Date.now() < deadline) {
    if (cursor.pending.length === 0) {
      if (cursor.keywordIdx >= CATEGORY_KEYWORDS.length) {
        cursor.exhausted = true;
        break;
      }
      // Day-dependent rotation so scanning starts somewhere new each day.
      const idx =
        (cursor.keywordIdx + currentDayNumber()) % CATEGORY_KEYWORDS.length;
      const { keyword, category } = CATEGORY_KEYWORDS[idx];
      const candidates = await browseSearch(keyword, category, cursor.pageOffset);
      // Advance: next page of this keyword, or the next keyword when the
      // pages run dry.
      if (
        candidates.length < BROWSE_PAGE_SIZE ||
        cursor.pageOffset + BROWSE_PAGE_SIZE >= BROWSE_PAGE_SIZE * MAX_PAGES_PER_KEYWORD
      ) {
        cursor.keywordIdx++;
        cursor.pageOffset = 0;
      } else {
        cursor.pageOffset += BROWSE_PAGE_SIZE;
      }
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
