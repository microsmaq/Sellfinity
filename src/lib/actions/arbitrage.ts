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
      profitCents: row.profitCents,
      marginPct: row.marginPct,
      estimatedSales30d: row.ebaySales30d,
      competitorCount: row.competitorCount,
      averageCompetitorPriceCents: row.avgCompPriceCents,
      suggestedPriceCents: row.suggestedListingPriceCents,
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

export type MatchVerificationResult = {
  ebayItemId: string;
  verdict: string;
  confidence: number;
  reason: string;
  method: string;
};

type MatchVerificationRow = {
  ebayItemId: string;
  ebayTitle: string;
  imageUrl: string;
  amazonTitle: string;
};

async function assessAndPersistMatches(
  rows: MatchVerificationRow[],
): Promise<MatchVerificationResult[]> {
  if (rows.length === 0) return [];
  const assessed = await Promise.all(
    rows.map(async (row) => ({
      row,
      assessment: await assessProductMatch(
        { title: row.ebayTitle, imageUrl: row.imageUrl },
        { title: row.amazonTitle },
      ),
    })),
  );
  await db.$transaction(
    assessed.map(({ row, assessment }) =>
      db.arbitrageItem.update({
        where: { ebayItemId: row.ebayItemId },
        data: {
          matchVerdict: assessment.verdict,
          matchConfidence: assessment.confidence,
          matchReason: assessment.reason,
          matchMethod: assessment.method,
          matchCheckedAt: new Date(),
        },
      }),
    ),
  );
  return assessed.map(({ row, assessment }) => ({
    ebayItemId: row.ebayItemId,
    ...assessment,
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
  remaining: number;
};

/** Verify the next small batch of legacy rows. The browser calls this
 * repeatedly, so progress survives timeouts, refreshes, and interrupted runs. */
export async function verifyHistoricalArbitrageMatches(
  requestedBatchSize = 10,
): Promise<HistoricalMatchBatchResult> {
  await requireUser();
  const batchSize = Math.min(10, Math.max(1, requestedBatchSize));
  const rows = await db.arbitrageItem.findMany({
    where: { matchVerdict: "UNVERIFIED" },
    orderBy: [{ createdAt: "asc" }, { ebayItemId: "asc" }],
    take: batchSize,
    select: {
      ebayItemId: true,
      ebayTitle: true,
      imageUrl: true,
      amazonTitle: true,
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
      (result) => result.verdict === "REJECTED" || result.verdict === "REVIEW",
    ).length,
    aiChecked: results.filter((result) => result.method === "AI").length,
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
    { marketPriceCents: ebayPriceCents },
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
      { marketPriceCents: item.ebayPriceCents },
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
