"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scanMore } from "@/lib/arbitrage";
import {
  listArbitragePage,
  type ArbitragePage,
  type ArbitragePageParams,
} from "@/lib/arbitrage/store";
import type { ScanReport } from "@/lib/arbitrage/scan-types";
import { getScraper } from "@/lib/mirror";
import { mirrorUrl, type MirrorOutcome } from "@/lib/mirror/pipeline";
import { researchEbayMarket } from "@/lib/ebay/market";
import { db } from "@/lib/db";
import type { ListingMarketMetrics } from "@/lib/listings/market-metrics";
import { createArbitrageWorkbook } from "@/lib/export/excel";
import { assessProductMatch } from "@/lib/arbitrage/product-match";
import { resolveExactAmazonVariant } from "@/lib/mirror/variant";
import { estimateMargin } from "@/lib/fees";

/** One page of the research database (filters/sort/pagination server-side). */
export async function fetchArbitragePage(
  params: ArbitragePageParams,
): Promise<ArbitragePage> {
  const user = await requireUser();
  return listArbitragePage(user.id, params);
}

export async function hideArbitrageItem(ebayItemId: string): Promise<void> {
  const user = await requireUser();
  const item = await db.arbitrageItem.findUnique({
    where: { ebayItemId },
    select: { ebayItemId: true },
  });
  if (!item) return;
  await db.hiddenArbitrageItem.upsert({
    where: { userId_ebayItemId: { userId: user.id, ebayItemId } },
    create: { userId: user.id, ebayItemId },
    update: {},
  });
  revalidatePath("/arbitrage");
}

export async function exportArbitrageExcel(params: ArbitragePageParams) {
  const user = await requireUser();
  const rows = [];
  let page = 1;
  let pageCount = 1;
  do {
    const result = await listArbitragePage(user.id, {
      ...params,
      page,
      pageSize: 100,
    });
    rows.push(...result.rows);
    pageCount = result.pageCount;
    page++;
  } while (page <= pageCount && rows.length < 2000);
  return createArbitrageWorkbook(
    rows.map((row) => ({
      title: row.title,
      category: row.category,
      ebayPriceCents: row.ebayPriceCents,
      amazonPriceCents: row.amazonPriceCents,
      profitCents: ["MATCH", "LIKELY"].includes(row.matchVerdict)
        ? row.profitCents
        : null,
      marginPct: ["MATCH", "LIKELY"].includes(row.matchVerdict)
        ? row.marginPct
        : null,
      estimatedSales30d: row.ebaySales30d,
      competitorCount: row.competitorCount,
      averageCompetitorPriceCents: row.avgCompPriceCents,
      suggestedPriceCents: ["MATCH", "LIKELY"].includes(row.matchVerdict)
        ? row.suggestedListingPriceCents
        : null,
      matchVerdict: row.matchVerdict,
      matchConfidence: row.matchConfidence,
      matchReason: row.matchReason,
      ebayUrl: row.ebayUrl,
      amazonUrl: row.amazonUrl,
    })),
  );
}

/** Advance the scan now ("add more to the database"). Each call is
 * time-boxed; the client loops until its target is reached. */
export async function scanForNew(target = 50): Promise<ScanReport> {
  await requireUser();
  const report = await scanMore({ target: Math.min(Math.max(1, target), 50) });
  revalidatePath("/arbitrage");
  return report;
}

export async function setArbitrageAutoPublish(enabled: boolean): Promise<void> {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { autoPublishArbitrage: enabled },
  });
  revalidatePath("/arbitrage");
  revalidatePath("/settings");
}

export type MatchVerificationResult = {
  ebayItemId: string;
  verdict: string;
  confidence: number;
  reason: string;
  method: string;
  error?: boolean;
};

type MatchVerificationRow = {
  ebayItemId: string;
  ebayTitle: string;
  imageUrl: string;
  amazonTitle: string;
  asin: string;
  amazonPriceCents: number;
  amazonUrl: string;
  ebayPriceCents: number;
};

async function assessAndPersistMatches(
  rows: MatchVerificationRow[],
): Promise<MatchVerificationResult[]> {
  if (rows.length === 0) return [];
  const assessed = await Promise.all(
    rows.map(async (row) => {
      try {
        const exact = await resolveExactAmazonVariant(
          { title: row.ebayTitle, imageUrl: row.imageUrl },
          {
            asin: row.asin,
            title: row.amazonTitle,
            priceCents: row.amazonPriceCents,
            url: row.amazonUrl,
          },
          { workflow: "historical_variant_verification" },
        );
        const identity = await assessProductMatch(
          { title: row.ebayTitle, imageUrl: row.imageUrl },
          {
            title: exact?.title ?? row.amazonTitle,
            imageUrl: exact?.imageUrl,
          },
        );
        const assessment = exact
          ? exact.variantAssessment ?? identity
          : identity.verdict === "REJECTED"
            ? identity
            : {
                verdict: "REVIEW" as const,
                confidence: identity.confidence,
                reason: `Likely product candidate, but the exact Amazon child variant and live price are not proven. ${identity.reason}`,
                method: identity.method,
              };
        return { row, exact, assessment, error: false };
      } catch (error) {
        return {
          row,
          exact: null,
          assessment: {
            verdict: "ERROR" as const,
            confidence: 0,
            reason: `Variant verification temporarily failed: ${
              error instanceof Error ? error.message.slice(0, 170) : "service unavailable"
            }`,
            method: "RULES" as const,
          },
          error: true,
        };
      }
    }),
  );
  await db.$transaction(
    assessed.map(({ row, exact, assessment }) => {
      const margin = exact
        ? estimateMargin(row.ebayPriceCents, exact.priceCents, 0)
        : null;
      return db.arbitrageItem.update({
        where: { ebayItemId: row.ebayItemId },
        data: {
          ...(exact && margin
            ? {
                asin: exact.asin,
                amazonTitle: exact.title,
                amazonPriceCents: exact.priceCents,
                amazonUrl: exact.url,
                profitCents: margin.estimatedProfitCents,
                marginPct: Math.round(margin.marginPct),
                feeCents: margin.estimatedFeeCents,
              }
            : {}),
          matchVerdict: assessment.verdict,
          matchConfidence: assessment.confidence,
          matchReason: assessment.reason,
          matchMethod: assessment.method,
          matchCheckedAt: new Date(),
        },
      });
    }),
  );
  return assessed.map(({ row, assessment, error }) => ({
    ebayItemId: row.ebayItemId,
    ...assessment,
    error,
  }));
}

/** Re-check existing research rows. Rejected and review-required pairs are
 * retained for auditability but automatically disappear from finder results. */
export async function verifyArbitrageMatches(
  ebayItemIds: string[],
): Promise<MatchVerificationResult[]> {
  await requireUser();
  const ids = [...new Set(ebayItemIds)].slice(0, 10);
  const rows = await db.arbitrageItem.findMany({
    where: { ebayItemId: { in: ids } },
    select: {
      ebayItemId: true,
      ebayTitle: true,
      imageUrl: true,
      amazonTitle: true,
      asin: true,
      amazonPriceCents: true,
      amazonUrl: true,
      ebayPriceCents: true,
    },
  });
  const results = await assessAndPersistMatches(rows);
  revalidatePath("/arbitrage");
  return results;
}

export type HistoricalMatchBatchResult = {
  processed: number;
  approved: number;
  removed: number;
  aiChecked: number;
  errors: number;
  remaining: number;
};

/** Verify the next small batch of legacy rows. The browser calls this
 * repeatedly, so progress survives timeouts, refreshes, and interrupted runs. */
export async function verifyHistoricalArbitrageMatches(
  requestedBatchSize = 4,
): Promise<HistoricalMatchBatchResult> {
  await requireUser();
  // Retry rows abandoned by a transient provider failure, but not repeatedly
  // within the same long-running browser job.
  await db.arbitrageItem.updateMany({
    where: {
      matchVerdict: "ERROR",
      matchCheckedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
    },
    data: { matchVerdict: "UNVERIFIED", matchCheckedAt: null },
  });
  const batchSize = Math.min(4, Math.max(1, requestedBatchSize));
  const rows = await db.arbitrageItem.findMany({
    where: { matchVerdict: "UNVERIFIED" },
    orderBy: [{ createdAt: "asc" }, { ebayItemId: "asc" }],
    take: batchSize,
    select: {
      ebayItemId: true,
      ebayTitle: true,
      imageUrl: true,
      amazonTitle: true,
      asin: true,
      amazonPriceCents: true,
      amazonUrl: true,
      ebayPriceCents: true,
    },
  });
  const results = await assessAndPersistMatches(rows);
  const remaining = await db.arbitrageItem.count({
    where: { matchVerdict: "UNVERIFIED" },
  });
  revalidatePath("/arbitrage");
  return {
    processed: results.length,
    approved: results.filter(
      (result) => result.verdict === "MATCH" || result.verdict === "LIKELY",
    ).length,
    removed: results.filter(
      (result) =>
        !result.error && (result.verdict === "REJECTED" || result.verdict === "REVIEW"),
    ).length,
    aiChecked: results.filter((result) => result.method === "AI").length,
    errors: results.filter((result) => result.error).length,
    remaining,
  };
}

export type ArbitrageMarketResult = {
  asin: string;
  ebayItemId: string;
  market: ListingMarketMetrics | null;
  error?: string;
};

/** Refresh demand, competition, and average comp price for a small batch of
 * arbitrage rows using the same eBay market research as Listings. */
export async function researchArbitrageMarket(
  items: { asin: string; ebayItemId: string; title: string }[],
): Promise<ArbitrageMarketResult[]> {
  await requireUser();
  const results: ArbitrageMarketResult[] = [];
  for (const item of items.slice(0, 10)) {
    try {
      const result = await researchEbayMarket(item.title, item.ebayItemId);
      if (!result) {
        results.push({ asin: item.asin, ebayItemId: item.ebayItemId, market: null });
        continue;
      }
      await db.arbitrageItem.updateMany({
        where: { asin: item.asin, ebayItemId: item.ebayItemId },
        data: {
          salesEst: result.metrics.estimatedSales30d,
          competitorCount: result.metrics.competitorCount,
          avgCompPriceCents: result.metrics.averageCompetitorPriceCents,
        },
      });
      results.push({
        asin: item.asin,
        ebayItemId: item.ebayItemId,
        market: result.metrics,
      });
    } catch (error) {
      results.push({
        asin: item.asin,
        ebayItemId: item.ebayItemId,
        market: null,
        error: error instanceof Error ? error.message.slice(0, 120) : "Research failed",
      });
    }
  }
  revalidatePath("/arbitrage");
  return results;
}

/**
 * Mirror an arbitrage opportunity's Amazon product into the user's store,
 * pricing the draft against the known eBay comp instead of an estimate.
 */
export async function mirrorOpportunity(
  asin: string,
  ebayPriceCents: number,
): Promise<MirrorOutcome> {
  const user = await requireUser();
  const outcome = await mirrorUrl(
    user.id,
    `https://www.amazon.com/dp/${asin}`,
    getScraper(),
    {
      marketPriceCents: ebayPriceCents,
      improveMainImage: user.improveMainImage,
      improveListingContent: user.improveListingContent,
    },
  );
  revalidatePath("/arbitrage");
  revalidatePath("/listings");
  return outcome;
}

export type BulkMirrorResult = {
  mirroredAsins: string[];
  failed: number;
  error?: string;
};

/** Bulk-mirror selected opportunities (up to 50 per call). */
export async function mirrorOpportunities(
  items: { asin: string; ebayPriceCents: number }[],
): Promise<BulkMirrorResult> {
  const user = await requireUser();
  const mirroredAsins: string[] = [];
  let failed = 0;
  let firstError: string | undefined;

  for (const item of items.slice(0, 50)) {
    const outcome = await mirrorUrl(
      user.id,
      `https://www.amazon.com/dp/${item.asin}`,
      getScraper(),
      {
        marketPriceCents: item.ebayPriceCents,
        improveMainImage: user.improveMainImage,
        improveListingContent: user.improveListingContent,
      },
    );
    if (outcome.ok) mirroredAsins.push(item.asin);
    else {
      failed++;
      firstError ??= outcome.error;
    }
  }
  revalidatePath("/arbitrage");
  revalidatePath("/listings");
  return { mirroredAsins, failed, error: firstError };
}
