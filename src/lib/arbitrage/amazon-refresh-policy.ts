import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  AUTO_PUBLISH_FLAT_PROFIT_CENTS,
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
} from "./auto-publish";
import {
  refreshAdminAmazonCost,
  researchAdminCatalogProduct,
} from "./admin-research";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const AUTO_PUBLISH_AMAZON_MAX_AGE_MS = 6 * HOUR;
export const HIGH_RISK_AMAZON_MAX_AGE_MS = 6 * HOUR;
export const ACTIVE_AMAZON_MAX_AGE_MS = DAY;
export const UNAVAILABLE_AMAZON_RETRY_MS = 12 * HOUR;
export const LOW_PRIORITY_AMAZON_MAX_AGE_MS = 7 * DAY;
export const HIGH_VALUE_AMAZON_COST_CENTS = 5_000;
export const LOW_MARGIN_THRESHOLD_PCT = 20;

export type AmazonRefreshTier =
  | "AUTO_PUBLISH"
  | "RECENT_ORDER"
  | "HIGH_RISK_ACTIVE"
  | "ACTIVE_LISTING"
  | "UNAVAILABLE"
  | "PUBLISHED_CATALOG"
  | "LOW_PRIORITY";

export type PrioritizedAmazonRefreshItem = {
  id: string;
  asin: string;
  tier: AmazonRefreshTier;
  unavailable: boolean;
};

export type PrioritizedAmazonRefreshReport = {
  selected: number;
  processed: number;
  succeeded: number;
  failed: number;
  remaining: number;
  stoppedForTime: boolean;
  tiers: Partial<Record<AmazonRefreshTier, number>>;
  errors: string[];
};

function staleWhere(now: Date, ageMs: number): Prisma.AdminArbitrageProductWhereInput {
  return {
    OR: [
      { amazonRefreshedAt: null },
      { amazonRefreshedAt: { lt: new Date(now.getTime() - ageMs) } },
    ],
  };
}

/** Automatic publishing is allowed only from a recent, available snapshot. */
export function hasFreshAmazonSnapshot(
  refreshedAt: Date | null,
  inStock: boolean,
  now = new Date(),
): boolean {
  return Boolean(
    inStock &&
    refreshedAt &&
    refreshedAt.getTime() >= now.getTime() - AUTO_PUBLISH_AMAZON_MAX_AGE_MS,
  );
}

/** Select the highest-value stale rows without refreshing the whole catalog. */
export async function selectPrioritizedAmazonRefreshItems(
  now = new Date(),
  requestedLimit = 100,
): Promise<PrioritizedAmazonRefreshItem[]> {
  const limit = Math.max(1, Math.min(200, requestedLimit));
  const recentOrderCutoff = new Date(now.getTime() - 7 * DAY);
  const [activeProducts, recentOrderProducts] = await Promise.all([
    db.product.findMany({
      where: {
        supplierName: "Amazon",
        listings: { some: { status: "ACTIVE" } },
      },
      distinct: ["supplierProductId"],
      select: { supplierProductId: true },
    }),
    db.product.findMany({
      where: {
        supplierName: "Amazon",
        listings: {
          some: {
            orders: {
              some: { status: "PAID", saleDate: { gte: recentOrderCutoff } },
            },
          },
        },
      },
      distinct: ["supplierProductId"],
      select: { supplierProductId: true },
    }),
  ]);
  const activeAsins = activeProducts.map((row) => row.supplierProductId);
  const recentOrderAsins = recentOrderProducts.map((row) => row.supplierProductId);
  const selected: PrioritizedAmazonRefreshItem[] = [];
  const selectedIds: string[] = [];

  async function addTier(
    tier: AmazonRefreshTier,
    where: Prisma.AdminArbitrageProductWhereInput,
  ) {
    const remaining = limit - selected.length;
    if (remaining <= 0) return;
    const rows = await db.adminArbitrageProduct.findMany({
      where: {
        status: { not: "ARCHIVED" },
        ...(selectedIds.length > 0 && { id: { notIn: selectedIds } }),
        AND: [where],
      },
      orderBy: [
        { amazonRefreshedAt: { sort: "asc", nulls: "first" } },
        { updatedAt: "asc" },
      ],
      take: remaining,
      select: { id: true, asin: true, amazonInStock: true },
    });
    for (const row of rows) {
      selectedIds.push(row.id);
      selected.push({
        id: row.id,
        asin: row.asin,
        tier,
        unavailable: !row.amazonInStock,
      });
    }
  }

  await addTier("AUTO_PUBLISH", {
    status: "PUBLISHED",
    amazonInStock: true,
    matchVerdict: { in: ["MATCH", "LIKELY"] },
    matchConfidence: { gte: AUTO_PUBLISH_MIN_MATCH_CONFIDENCE },
    estimatedProfitCents: { gt: 0 },
    AND: [
      staleWhere(now, AUTO_PUBLISH_AMAZON_MAX_AGE_MS),
      {
        OR: [
          { marginPct: { gte: AUTO_PUBLISH_MIN_MARGIN_PCT } },
          { estimatedProfitCents: { gte: AUTO_PUBLISH_FLAT_PROFIT_CENTS } },
        ],
      },
    ],
  });
  if (recentOrderAsins.length > 0) {
    await addTier("RECENT_ORDER", {
      asin: { in: recentOrderAsins },
      ...staleWhere(now, HIGH_RISK_AMAZON_MAX_AGE_MS),
    });
  }
  if (activeAsins.length > 0) {
    await addTier("HIGH_RISK_ACTIVE", {
      asin: { in: activeAsins },
      AND: [
        staleWhere(now, HIGH_RISK_AMAZON_MAX_AGE_MS),
        {
          OR: [
            { amazonPriceCents: { gte: HIGH_VALUE_AMAZON_COST_CENTS } },
            { marginPct: { lte: LOW_MARGIN_THRESHOLD_PCT } },
          ],
        },
      ],
    });
    await addTier("ACTIVE_LISTING", {
      asin: { in: activeAsins },
      ...staleWhere(now, ACTIVE_AMAZON_MAX_AGE_MS),
    });
  }
  await addTier("UNAVAILABLE", {
    amazonInStock: false,
    ...staleWhere(now, UNAVAILABLE_AMAZON_RETRY_MS),
  });
  await addTier("PUBLISHED_CATALOG", {
    status: "PUBLISHED",
    ...staleWhere(now, ACTIVE_AMAZON_MAX_AGE_MS),
  });
  await addTier("LOW_PRIORITY", staleWhere(now, LOW_PRIORITY_AMAZON_MAX_AGE_MS));
  return selected;
}

/** Execute selected refreshes sequentially within the serverless deadline. */
export async function refreshPrioritizedAmazonCatalog(options: {
  now?: Date;
  maxItems?: number;
  timeBudgetMs?: number;
} = {}): Promise<PrioritizedAmazonRefreshReport> {
  const now = options.now ?? new Date();
  const items = await selectPrioritizedAmazonRefreshItems(
    now,
    options.maxItems ?? 100,
  );
  const deadline = Date.now() + (options.timeBudgetMs ?? 260_000);
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const tiers: Partial<Record<AmazonRefreshTier, number>> = {};
  const errors: string[] = [];

  for (const item of items) {
    if (Date.now() >= deadline) break;
    processed++;
    tiers[item.tier] = (tiers[item.tier] ?? 0) + 1;
    try {
      if (item.unavailable) await researchAdminCatalogProduct(item.id);
      else await refreshAdminAmazonCost(item.id);
      succeeded++;
    } catch (error) {
      failed++;
      if (errors.length < 5) {
        errors.push(
          `${item.asin}: ${error instanceof Error ? error.message : "refresh failed"}`.slice(0, 240),
        );
      }
    }
  }

  return {
    selected: items.length,
    processed,
    succeeded,
    failed,
    remaining: items.length - processed,
    stoppedForTime: processed < items.length,
    tiers,
    errors,
  };
}
