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
    orderBy: [
      { lastResearchedAt: { sort: "asc", nulls: "first" } },
      { updatedAt: "asc" },
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
