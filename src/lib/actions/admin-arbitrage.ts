"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { scanMore } from "@/lib/arbitrage";
import {
  addAmazonCatalogProduct,
  refreshAdminAmazonCost,
  refreshAdminEbayMarket,
  researchAdminCatalogProduct,
} from "@/lib/arbitrage/admin-research";
import { publishCatalogProductToUsers } from "@/lib/arbitrage/admin-catalog";
import type { ScanReport } from "@/lib/arbitrage/scan-types";
import { getRainforestEfficiencySummary } from "@/lib/mirror/rainforest";
import { recalculateAllArbitragePricing } from "@/lib/arbitrage/recalculate-pricing";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";
import { estimateMargin } from "@/lib/fees";
import { AMAZON_FRESHNESS_WINDOW_MS } from "@/lib/amazon/freshness";

export type AdminActionResult = {
  ok: boolean;
  message: string;
};

export type AdminScanResult = AdminActionResult & ScanReport;
export type AdminRefreshMode = "MARKET" | "AMAZON";

export type AdminRefreshBatchResult = AdminActionResult & {
  processed: number;
  succeeded: number;
  failed: number;
  rainforestRequests: number;
  cacheHits: number;
};

export type AdminLiveAmazonRequest = {
  requestKey: string;
  amazonUrl: string;
  orderIds: string[];
};

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "The operation failed.";
}

export async function adminRecalculateArbitragePricing(): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    const result = await recalculateAllArbitragePricing();
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return {
      ok: true,
      message: `Pricing recalculated for ${result.catalogUpdated} catalog products and ${result.researchUpdated} research rows. No API credits used.`,
    };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function prepareAdminLiveAmazonRefresh(
  selectedIds?: string[],
  skipRecentlyChecked = true,
): Promise<{ requests: AdminLiveAmazonRequest[]; skippedFresh: number }> {
  await requireAdmin();
  const skipFresh = z.boolean().parse(skipRecentlyChecked);
  const freshnessCutoff = new Date(Date.now() - AMAZON_FRESHNESS_WINDOW_MS);
  const ids = selectedIds?.length
    ? z.array(z.string().min(1).max(100)).max(5_000).parse([...new Set(selectedIds)])
    : undefined;
  const rows = await db.adminArbitrageProduct.findMany({
    where: {
      status: { not: "ARCHIVED" },
      ...(ids && { id: { in: ids } }),
      ...(skipFresh && { OR: [{ amazonRefreshedAt: null }, { amazonRefreshedAt: { lt: freshnessCutoff } }] }),
    },
    select: { id: true, asin: true, amazonUrl: true },
    orderBy: [{ amazonRefreshedAt: { sort: "asc", nulls: "first" } }, { updatedAt: "asc" }],
  });
  const grouped = new Map<string, AdminLiveAmazonRequest>();
  for (const row of rows) {
    const requestKey = row.asin.trim().toUpperCase();
    const current = grouped.get(requestKey);
    if (current) current.orderIds.push(row.id);
    else grouped.set(requestKey, {
      requestKey,
      amazonUrl: /^[A-Z0-9]{10}$/i.test(requestKey) ? `https://www.amazon.com/dp/${requestKey}` : row.amazonUrl,
      orderIds: [row.id],
    });
  }
  const requestedCount = ids?.length ?? await db.adminArbitrageProduct.count({ where: { status: { not: "ARCHIVED" } } });
  return { requests: [...grouped.values()], skippedFresh: Math.max(0, requestedCount - rows.length) };
}

export async function adminUpdateAmazonCostsFromBrowser(
  rawIds: string[],
  rawPriceCents: number,
  rawShippingCents: number | null,
): Promise<{ updatedIds: string[]; priceCents: number; shippingCents: number | null } | { error: string }> {
  await requireAdmin();
  const ids = z.array(z.string().min(1).max(100)).min(1).max(100).parse([...new Set(rawIds)]);
  const priceCents = Math.round(rawPriceCents);
  const shippingCents = rawShippingCents === null ? null : Math.round(rawShippingCents);
  if (!Number.isFinite(priceCents) || priceCents <= 0 || priceCents > 1_000_000
    || (shippingCents !== null && (!Number.isFinite(shippingCents) || shippingCents < 0 || shippingCents > 100_000))) {
    return { error: "Amazon returned an invalid price or shipping amount." };
  }
  const rows = await db.adminArbitrageProduct.findMany({ where: { id: { in: ids } } });
  if (!rows.length) return { error: "No matching admin catalog products were found." };
  await db.$transaction(rows.flatMap((row) => {
    const nextShipping = shippingCents ?? row.amazonShippingCents;
    const suggested = row.ebayPriceCents
      ? arbitrageSuggestedPriceCents(priceCents, row.ebayPriceCents, row.ebayRecommendedPriceCents, row.averageCompetitorPriceCents ?? row.ebayPriceCents, nextShipping)
      : null;
    const margin = suggested ? estimateMargin(suggested, priceCents, nextShipping) : null;
    return [
      db.adminArbitrageProduct.update({
        where: { id: row.id },
        data: {
          amazonPriceCents: priceCents,
          amazonShippingCents: nextShipping,
          amazonInStock: true,
          amazonRefreshedAt: new Date(),
          suggestedPriceCents: suggested,
          estimatedProfitCents: margin?.estimatedProfitCents ?? null,
          marginPct: margin ? Math.round(margin.marginPct) : null,
        },
      }),
      db.arbitrageItem.updateMany({
        where: { asin: row.asin },
        data: {
          amazonPriceCents: priceCents,
          amazonShippingCents: nextShipping,
          ...(margin && {
            profitCents: margin.estimatedProfitCents,
            marginPct: Math.round(margin.marginPct),
            feeCents: margin.estimatedFeeCents,
          }),
        },
      }),
    ];
  }));
  revalidatePath("/admin/arbitrage");
  revalidatePath("/arbitrage");
  return { updatedIds: rows.map((row) => row.id), priceCents, shippingCents };
}

export async function adminMarkAmazonUnavailableFromBrowser(rawIds: string[]): Promise<{ updatedIds: string[] } | { error: string }> {
  await requireAdmin();
  const ids = z.array(z.string().min(1).max(100)).min(1).max(100).parse([...new Set(rawIds)]);
  const result = await db.adminArbitrageProduct.updateMany({
    where: { id: { in: ids } },
    data: { amazonInStock: false, amazonRefreshedAt: new Date() },
  });
  if (!result.count) return { error: "No matching admin catalog products were found." };
  revalidatePath("/admin/arbitrage");
  revalidatePath("/arbitrage");
  return { updatedIds: ids };
}

export async function adminAddAmazonItem(
  input: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await addAmazonCatalogProduct(input);
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return {
      ok: true,
      message: "Amazon item added and its eBay market research is complete.",
    };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminResearchItem(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await researchAdminCatalogProduct(z.string().min(1).max(100).parse(id));
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "Amazon price, match, and market data refreshed." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminPublishItem(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await publishCatalogProductToUsers(z.string().min(1).max(100).parse(id));
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "This product is now visible to users." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminArchiveItem(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    const item = await db.adminArbitrageProduct.findUniqueOrThrow({
      where: { id: z.string().min(1).max(100).parse(id) },
      select: { id: true, ebayItemId: true },
    });
    await db.$transaction([
      db.adminArbitrageProduct.update({
        where: { id: item.id },
        data: { status: "ARCHIVED" },
      }),
      db.arbitrageItem.deleteMany({
        where: { ebayItemId: item.ebayItemId ?? "__none__" },
      }),
    ]);
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "Product archived and removed from user results." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminScanBestSellers(
  count: number,
): Promise<AdminScanResult> {
  await requireAdmin();
  const target = z.number().int().min(1).max(100).parse(count);
  try {
    // Keep every request comfortably below the hosting timeout. The admin
    // client resumes these persisted checkpoints until its requested total is
    // reached, the sources are exhausted, or the administrator stops it.
    const report = await scanMore({ target, timeBudgetMs: 22_000 });
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return {
      ...report,
      ok: true,
      message: report.paused
        ? `Research checkpoint saved: ${report.added} products added and ${report.examined} candidates examined. A provider lookup will be retried automatically.`
        : report.exhausted
          ? `Research complete: ${report.added} new products added; the available bestseller sources were exhausted.`
          : `Research checkpoint saved: ${report.added} new products added from ${report.examined} candidates.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: message(error),
      added: 0,
      examined: 0,
      exhausted: false,
      errors: 1,
      paused: true,
    };
  }
}

export async function prepareAdminCatalogRefresh(
  mode: AdminRefreshMode,
  count: number,
): Promise<{ ids: string[]; mode: AdminRefreshMode }> {
  await requireAdmin();
  const parsedMode = z.enum(["MARKET", "AMAZON"]).parse(mode);
  const take = z.number().int().min(1).max(50).parse(count);
  const rows = await db.adminArbitrageProduct.findMany({
    where: {
      status: { not: "ARCHIVED" },
      ...(parsedMode === "MARKET" && { ebayItemId: { not: null } }),
    },
    orderBy: parsedMode === "AMAZON"
      ? [
          { amazonRefreshedAt: { sort: "asc" as const, nulls: "first" as const } },
          { updatedAt: "asc" as const },
        ]
      : [
          { lastResearchedAt: { sort: "asc" as const, nulls: "first" as const } },
          { updatedAt: "asc" as const },
        ],
    take,
    select: { id: true },
  });
  return { ids: rows.map((row) => row.id), mode: parsedMode };
}

/** Process a small explicit checkpoint so a refresh survives serverless
 * request limits. The browser owns the fixed target list, preventing a
 * failed row from being selected repeatedly in the same manual run. */
export async function adminRefreshCatalogBatch(
  mode: AdminRefreshMode,
  ids: string[],
): Promise<AdminRefreshBatchResult> {
  await requireAdmin();
  const parsedMode = z.enum(["MARKET", "AMAZON"]).parse(mode);
  const parsedIds = z.array(z.string().min(1).max(100)).min(1).max(5).parse(ids);
  const before = parsedMode === "AMAZON"
    ? await getRainforestEfficiencySummary()
    : null;
  let succeeded = 0;
  let failed = 0;
  for (const id of parsedIds) {
    try {
      if (parsedMode === "AMAZON") await refreshAdminAmazonCost(id);
      else await refreshAdminEbayMarket(id);
      succeeded++;
    } catch {
      failed++;
    }
  }
  const after = parsedMode === "AMAZON"
    ? await getRainforestEfficiencySummary()
    : null;
  revalidatePath("/admin/arbitrage");
  revalidatePath("/arbitrage");
  return {
    ok: failed === 0,
    message: failed
      ? `${succeeded} refreshed; ${failed} could not be updated.`
      : `${succeeded} catalog products refreshed.`,
    processed: parsedIds.length,
    succeeded,
    failed,
    rainforestRequests:
      before && after
        ? Math.max(0, after.providerRequests - before.providerRequests)
        : 0,
    cacheHits:
      before && after ? Math.max(0, after.cacheHits - before.cacheHits) : 0,
  };
}
