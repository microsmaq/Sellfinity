// Real arbitrage scanner: eBay Browse API (real active listings) matched to
// Amazon products via the Rainforest search API. Results are cached per UTC
// day in ScanCache and shared across users; asking for a larger count
// resumes the day's scan where it left off, so credits are only spent on new
// rows (roughly one Rainforest credit per eBay candidate examined).

import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import { appAccessToken, ebayEnvConfig } from "@/lib/ebay/oauth";
import {
  findAmazonCatalogProducts,
  findAmazonMatch,
  type AmazonMatch,
} from "@/lib/mirror/match";
import { resolveExactAmazonVariant } from "@/lib/mirror/variant";
import { persistOpportunities } from "./store";
import type { ArbitrageOpportunity } from "./scanner";
import type { ScanReport } from "./scan-types";
export { estimatedSales30d } from "./demand";
import { estimatedSales30d } from "./demand";
import { assessProductMatchRules } from "./product-match";

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
const LOOKUP_BATCH = 3;

type EbayCandidate = {
  itemId: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl: string;
  category: string;
  amazonSeed?: AmazonMatch;
};

type ScanCursor = {
  pending: EbayCandidate[];
  keywordIdx: number;
  pageOffset: number;
  exhausted: boolean;
  failures?: Record<string, { attempts: number; retryAfter: number }>;
};

const EMPTY_CURSOR: ScanCursor = {
  pending: [],
  keywordIdx: 0,
  pageOffset: 1,
  exhausted: false,
  failures: {},
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
  limit = BROWSE_PAGE_SIZE,
): Promise<EbayCandidate[]> {
  const config = ebayEnvConfig();
  if (!config) return [];
  const token = await appAccessToken(config);
  const params = new URLSearchParams({
    q: keyword,
    limit: String(limit),
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

async function ebayCandidatesForAmazonSources(
  sources: AmazonMatch[],
  category: string,
): Promise<EbayCandidate[]> {
  const candidates: EbayCandidate[] = [];
  // eBay lookups do not consume Rainforest credits. Four-at-a-time keeps a
  // source page inside serverless limits without creating a large burst.
  for (let index = 0; index < sources.length; index += 4) {
    const group = await Promise.all(
      sources.slice(index, index + 4).map(async (source) => {
        const ebayRows = await browseSearch(source.title, category, 0, 10);
        const ranked = ebayRows
          .map((candidate) => ({
            candidate,
            assessment: assessProductMatchRules(candidate.title, source.title),
          }))
          .filter(
            ({ candidate, assessment }) =>
              assessment.verdict !== "REJECTED" &&
              candidate.priceCents >= source.priceCents,
          )
          .sort(
            (left, right) =>
              right.assessment.confidence - left.assessment.confidence ||
              right.candidate.priceCents - left.candidate.priceCents,
          );
        return ranked[0]
          ? { ...ranked[0].candidate, amazonSeed: source }
          : null;
      }),
    );
    for (const candidate of group) {
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

/** Find the Amazon counterpart of an eBay candidate. Search is paid, so all
 * cheap local rejection gates run before buying exact-variant detail. */
async function amazonMatch(
  candidate: EbayCandidate,
): Promise<ArbitrageOpportunity | null> {
  const seed = candidate.amazonSeed ?? await findAmazonMatch(candidate.title, {
    throwOnError: true,
    workflow: "arbitrage_scan_search_fallback",
  });
  if (!seed) return null;
  const seedAssessment = assessProductMatchRules(candidate.title, seed.title);
  if (seedAssessment.verdict === "REJECTED") return null;
  // The search response already contains a current price. Avoid a second
  // paid request for candidates that cannot be profitable even before exact
  // child-variant verification.
  if (seed.priceCents > candidate.priceCents) return null;
  const match = await resolveExactAmazonVariant(
    { title: candidate.title, imageUrl: candidate.imageUrl },
    seed,
    { workflow: "arbitrage_scan_variant" },
  );
  // Preserve plausible candidates for human review when Amazon cannot prove
  // one exact, live-priced child variant. The UI keeps their estimated
  // profitability non-actionable until verification succeeds.
  const source = match ?? seed;
  const assessment = match
    ? match.variantAssessment ?? seedAssessment
    : {
        verdict: "REVIEW" as const,
        confidence: seedAssessment.confidence,
        reason: `Likely product candidate, but the exact Amazon child variant and live price are not proven. ${seedAssessment.reason}`,
        method: seedAssessment.method,
      };
  // Break-even and better both qualify: the Amazon source just can't cost
  // more than the eBay comp — the seller adds their margin at publish time.
  if (source.priceCents > candidate.priceCents) return null;

  if (assessment.verdict === "REJECTED") return null;

  const margin = estimateMargin(candidate.priceCents, source.priceCents, 0);

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
      asin: source.asin,
      title: source.title,
      priceCents: source.priceCents,
      url: source.url,
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
  const cursorKey = `arbitrage:source-cursor3:${currentDayNumber()}`;
  const cursor = await loadJson<ScanCursor>(cursorKey, EMPTY_CURSOR);
  cursor.failures ??= {};
  const examinedList = await loadJson<string[]>("arbitrage:examined", []);
  const examined = new Set(examinedList);

  let added = 0;
  let examinedNow = 0;
  let errors = 0;
  let paused = false;

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
      // Source-first discovery: one paid Amazon search page yields many
      // source products, then eBay/local rules narrow them for free.
      const idx =
        (cursor.keywordIdx + currentDayNumber()) % CATEGORY_KEYWORDS.length;
      const { keyword, category } = CATEGORY_KEYWORDS[idx];
      let candidates: EbayCandidate[];
      try {
        const sources = await findAmazonCatalogProducts(
          keyword,
          cursor.pageOffset,
          "arbitrage_catalog_search",
        );
        candidates = await ebayCandidatesForAmazonSources(sources, category);
        if (sources.length === 0 || cursor.pageOffset >= MAX_PAGES_PER_KEYWORD) {
          cursor.keywordIdx++;
          cursor.pageOffset = 1;
        } else {
          cursor.pageOffset++;
        }
      } catch {
        paused = true;
        errors++;
        break;
      }
      const blocked = candidates.length > 0
        ? await db.arbitrageCandidateAttempt.findMany({
            where: {
              ebayItemId: { in: candidates.map((candidate) => candidate.itemId) },
              retryAfter: { gt: new Date() },
            },
            select: { ebayItemId: true },
          })
        : [];
      const blockedIds = new Set(blocked.map((attempt) => attempt.ebayItemId));
      cursor.pending.push(
        ...candidates.filter(
          (candidate) =>
            !examined.has(candidate.itemId) && !blockedIds.has(candidate.itemId),
        ),
      );
      continue;
    }

    const ready = cursor.pending.filter((candidate) => {
      const failure = cursor.failures?.[candidate.itemId];
      return !failure || failure.retryAfter <= Date.now();
    });
    if (ready.length === 0) {
      paused = true;
      break;
    }
    const batch = ready.slice(0, LOOKUP_BATCH);
    const batchIds = new Set(batch.map((candidate) => candidate.itemId));
    cursor.pending = cursor.pending.filter((candidate) => !batchIds.has(candidate.itemId));
    const outcomes = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return { candidate, match: await amazonMatch(candidate), failed: false };
        } catch {
          return { candidate, match: null, failed: true };
        }
      }),
    );
    const failed = outcomes.filter((outcome) => outcome.failed);
    const completed = outcomes.filter((outcome) => !outcome.failed);
    // Keep transient failures at the front of the persisted queue. Stop this
    // advance so the client can pause instead of hammering the provider.
    if (failed.length > 0) {
      for (const outcome of failed) {
        const previous = cursor.failures?.[outcome.candidate.itemId]?.attempts ?? 0;
        const attempts = previous + 1;
        cursor.failures![outcome.candidate.itemId] = {
          attempts,
          retryAfter: Date.now() + Math.min(60, 5 * 2 ** previous) * 60_000,
        };
        if (attempts < 3) cursor.pending.push(outcome.candidate);
        else examined.add(outcome.candidate.itemId);
      }
      errors += failed.length;
      paused = true;
    }
    for (const outcome of completed) {
      examined.add(outcome.candidate.itemId);
      delete cursor.failures![outcome.candidate.itemId];
      await db.arbitrageCandidateAttempt.upsert({
        where: { ebayItemId: outcome.candidate.itemId },
        create: {
          ebayItemId: outcome.candidate.itemId,
          outcome: outcome.match ? "MATCH" : "REJECTED",
          retryAfter: new Date(Date.now() + (outcome.match ? 30 : 14) * 86_400_000),
        },
        update: {
          outcome: outcome.match ? "MATCH" : "REJECTED",
          retryAfter: new Date(Date.now() + (outcome.match ? 30 : 14) * 86_400_000),
          checkedAt: new Date(),
        },
      });
    }
    examinedNow += completed.length;
    added += await persistOpportunities(
      completed
        .map((outcome) => outcome.match)
        .filter((match): match is ArbitrageOpportunity => match !== null),
    );
    await save();
    if (paused) break;
  }

  await save();
  return { added, examined: examinedNow, exhausted: cursor.exhausted, errors, paused };
}
