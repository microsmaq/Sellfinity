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
  attachAdminEbayCandidate,
  approveAdminEbayCandidate,
  rejectAdminEbayCandidate,
} from "@/lib/arbitrage/admin-research";
import { publishCatalogProductToUsers } from "@/lib/arbitrage/admin-catalog";
import type { ScanReport } from "@/lib/arbitrage/scan-types";
import { getRainforestEfficiencySummary } from "@/lib/mirror/rainforest";
import { recalculateAllArbitragePricing } from "@/lib/arbitrage/recalculate-pricing";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";
import { estimateMargin } from "@/lib/fees";
import { isAmazonDataFresh, latestAmazonCheckAt, oldestAmazonChecksFirst } from "@/lib/amazon/freshness";
import { amazonSourceVerification } from "@/lib/amazon/source-verification";
import { parseBrowserCatalogRefresh, browserCatalogContentPatch } from "@/lib/arbitrage/browser-catalog-refresh";

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
): Promise<{ requests: AdminLiveAmazonRequest[]; skippedFresh: number; publishedFirst: number; awaitingVerification: number }> {
  await requireAdmin();
  const skipFresh = z.boolean().parse(skipRecentlyChecked);
  const ids = selectedIds?.length
    ? z.array(z.string().min(1).max(100)).max(5_000).parse([...new Set(selectedIds)])
    : undefined;
  const rows = await db.adminArbitrageProduct.findMany({
    where: {
      status: { not: "ARCHIVED" },
      ...(ids && { id: { in: ids } }),
    },
    select: { id: true, asin: true, amazonUrl: true, amazonCheckedAt: true, amazonRefreshedAt: true, amazonInStock: true, amazonShippingVerified: true, amazonImportDetailsJson: true },
    orderBy: [{ amazonRefreshedAt: { sort: "asc", nulls: "first" } }, { updatedAt: "asc" }],
  });
  // Actual live seller listings, not admin catalog publication or drafts.
  // Only ASINs are read here; seller identities never leave this action.
  const publishedProducts = await db.product.findMany({
    where: { supplierName: "Amazon", listings: { some: { status: "ACTIVE", ebayListingId: { not: null } } } },
    select: { supplierProductId: true, sku: true },
  });
  const publishedAsins = new Set(publishedProducts.map((product) =>
    (product.supplierProductId || product.sku).trim().toUpperCase(),
  ));
  const isPublished = (asin: string) => publishedAsins.has(asin.trim().toUpperCase());
  const grouped = new Map<string, AdminLiveAmazonRequest>();
  // A recent import is not a verification. Live, unverified products bypass
  // the freshness skip in manual AND scheduled runs. Keep oldest-attempt-first
  // within each priority tier so a failed check does not monopolize the queue.
  const eligibleRows = oldestAmazonChecksFirst(rows.filter((row) =>
    !skipFresh || !isAmazonDataFresh(row.amazonRefreshedAt)
    || (isPublished(row.asin) && amazonSourceVerification(row).needsVerification),
  ), (row) => latestAmazonCheckAt(row.amazonCheckedAt, row.amazonRefreshedAt));
  const priority = (row: typeof rows[number]) => !isPublished(row.asin) ? 2
    : amazonSourceVerification(row).needsVerification ? 0 : 1;
  eligibleRows.sort((a, b) => priority(a) - priority(b));
  for (const row of eligibleRows) {
    const requestKey = row.asin.trim().toUpperCase();
    const current = grouped.get(requestKey);
    if (current) current.orderIds.push(row.id);
    else grouped.set(requestKey, {
      requestKey,
      amazonUrl: /^[A-Z0-9]{10}$/i.test(requestKey) ? `https://www.amazon.com/dp/${requestKey}` : row.amazonUrl,
      orderIds: [row.id],
    });
  }
  const requests = [...grouped.values()];
  return {
    requests,
    skippedFresh: rows.length - eligibleRows.length,
    publishedFirst: requests.filter((request) => isPublished(request.requestKey)).length,
    awaitingVerification: new Set(eligibleRows.filter((row) => isPublished(row.asin) && amazonSourceVerification(row).needsVerification).map((row) => row.asin.trim().toUpperCase())).size,
  };
}

export async function adminUpdateAmazonCostsFromBrowser(
  rawIds: string[],
  rawPriceCents: number,
  rawShippingCents: number | null,
  rawProductDetails?: unknown,
): Promise<{ updatedIds: string[]; priceCents: number; shippingCents: number | null; detailsUpdated: boolean } | { error: string }> {
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
  let productDetails: ReturnType<typeof parseBrowserCatalogRefresh>;
  const checkedAt = new Date();
  try {
    productDetails = parseBrowserCatalogRefresh(rawProductDetails);
    if (productDetails) {
      if (productDetails.availability !== "AVAILABLE" || productDetails.priceCents !== priceCents || productDetails.shippingCents !== shippingCents) return { error: "Amazon returned inconsistent price, shipping or availability details. This product was left unchanged; retry the check." };
      for (const row of rows) browserCatalogContentPatch(row, productDetails, checkedAt);
    }
  } catch (error) { return { error: message(error) }; }
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
          ...(shippingCents !== null && { amazonShippingVerified: true }),
          amazonImportDetailsJson: productDetails ? row.amazonImportDetailsJson : JSON.stringify({ ...JSON.parse(row.amazonImportDetailsJson || "{}"), availability: "AVAILABLE" }),
          amazonInStock: true,
          amazonRefreshedAt: checkedAt,
          ...(productDetails && browserCatalogContentPatch(row, productDetails, checkedAt)),
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
          ...(productDetails && { amazonTitle: productDetails.title, amazonUrl: `https://www.amazon.com/dp/${productDetails.asin}` }),
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
  return { updatedIds: rows.map((row) => row.id), priceCents, shippingCents, detailsUpdated: Boolean(productDetails) };
}

export async function adminMarkAmazonUnavailableFromBrowser(rawIds: string[]): Promise<{ updatedIds: string[] } | { error: string }> {
  await requireAdmin();
  const ids = z.array(z.string().min(1).max(100)).min(1).max(100).parse([...new Set(rawIds)]);
  const rows = await db.adminArbitrageProduct.findMany({ where: { id: { in: ids } } });
  if (!rows.length) return { error: "No matching admin catalog products were found." };
  await db.$transaction(rows.map((row) => db.adminArbitrageProduct.update({
    where: { id: row.id },
    data: { amazonInStock: false, amazonRefreshedAt: new Date(), amazonImportDetailsJson: JSON.stringify({ ...JSON.parse(row.amazonImportDetailsJson || "{}"), availability: "UNAVAILABLE" }) },
  })));
  revalidatePath("/admin/arbitrage");
  revalidatePath("/arbitrage");
  return { updatedIds: rows.map((row) => row.id) };
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

export async function adminAttachEbayCandidate(id: string, input: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await attachAdminEbayCandidate(
      z.string().min(1).max(100).parse(id),
      z.string().trim().min(1).max(500).parse(input),
    );
    revalidatePath("/admin/arbitrage");
    return { ok: true, message: "The eBay candidate is ready for manual comparison and approval." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminApproveEbayCandidate(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await approveAdminEbayCandidate(z.string().min(1).max(100).parse(id));
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "Match manually verified and published to users." };
  } catch (error) {
    return { ok: false, message: message(error) };
  }
}

export async function adminRejectEbayCandidate(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await rejectAdminEbayCandidate(z.string().min(1).max(100).parse(id));
    revalidatePath("/admin/arbitrage");
    revalidatePath("/arbitrage");
    return { ok: true, message: "Candidate rejected. You can research again or paste a different eBay item." };
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
