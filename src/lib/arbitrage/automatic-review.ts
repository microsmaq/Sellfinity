import "server-only";
import { db } from "@/lib/db";
import { researchAdminCatalogProduct } from "./admin-research";
import { prioritizeCatalogReview } from "@/lib/ai/jev-workflows";
import { reviewSavedCatalogCandidate } from "./review-saved-candidate";
import { CATALOG_REVIEW_DATA_MAX_AGE_MS } from "./automatic-review-policy";

export async function catalogReviewSettings() {
  return db.adminCatalogReviewAutomation.upsert({ where: { id: "main" }, create: { id: "main" }, update: {} });
}

export function highConfidenceCatalogWhere(now = new Date(), ids?: string[]) {
  return {
    status: "NO_MATCH", matchConfidence: { gte: 95 }, matchVerdict: { not: "REJECTED" }, matchMethod: { not: "MANUAL_REJECTED" }, ebayItemId: { not: null },
    ...(ids && { id: { in: ids } }), amazonInStock: true, amazonShippingVerified: true,
    amazonPriceCents: { gt: 0 }, amazonRefreshedAt: { gte: new Date(now.getTime() - CATALOG_REVIEW_DATA_MAX_AGE_MS) },
  };
}

/** A database lease prevents overlapping cron/manual research batches. */
export async function runAutomaticCatalogReview(force = false, reviewOnly = false, options: { ids?: string[]; limit?: number } = {}) {
  const settings = await catalogReviewSettings();
  if (!settings.enabled && !force) return { skipped: true, reason: "Automatic review is disabled." };
  const now = new Date();
  const lease = await db.adminCatalogReviewAutomation.updateMany({
    where: { id: "main", OR: [{ lockUntil: null }, { lockUntil: { lt: now } }] },
    data: { lockUntil: new Date(now.getTime() + 15 * 60 * 1000) },
  });
  if (!lease.count) return { skipped: true, reason: "Another catalog review is running." };
  const summary = { processed: 0, published: 0, review: 0, failed: 0, queued: 0, eligibleIds: [] as string[], items: [] as { id: string; asin: string; outcome: string; reason: string }[] };
  const deadline = Date.now() + 220_000;
  try {
    const savedReview = { status: "NO_MATCH", matchConfidence: { gte: 95 }, matchVerdict: { not: "REJECTED" }, matchMethod: { not: "MANUAL_REJECTED" }, ebayItemId: { not: null } };
    const where = reviewOnly ? highConfidenceCatalogWhere(now, options.ids) : {
      OR: [{ status: "PENDING", lastResearchedAt: null }, savedReview],
      ...(options.ids && { id: { in: options.ids } }),
      amazonInStock: true, amazonShippingVerified: true,
      amazonPriceCents: { gt: 0 },
      amazonRefreshedAt: { gte: new Date(now.getTime() - CATALOG_REVIEW_DATA_MAX_AGE_MS) },
    };
    const candidates = await db.adminArbitrageProduct.findMany({
      where, orderBy: { updatedAt: "asc" }, take: force && options.limit ? Math.max(1, Math.min(25, options.limit)) : settings.dailyLimit,
      select: { id: true, asin: true, amazonTitle: true, ebayTitle: true, status: true },
    });
    summary.eligibleIds = candidates.map((candidate) => candidate.id);
    // Saved pairs are already high-confidence and ordered by oldest attempt.
    // Avoid an extra AI prioritization call before the actual approval checks.
    const prioritized = reviewOnly ? candidates : await prioritizeCatalogReview(candidates);
    for (const candidate of prioritized) {
      if (Date.now() + 90_000 > deadline) break;
      try {
        if (candidate.status === "NO_MATCH") await reviewSavedCatalogCandidate(candidate.id);
        else await researchAdminCatalogProduct(candidate.id, { automatic: true, ebayOnly: true });
        const result = await db.adminArbitrageProduct.findUnique({ where: { id: candidate.id }, select: { status: true, matchReason: true } });
        const published = result?.status === "PUBLISHED";
        if (published) summary.published++; else summary.review++;
        summary.items.push({ id: candidate.id, asin: candidate.asin, outcome: published ? "published" : "review", reason: result?.matchReason ?? "Manual review required." });
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 500) : "Automatic research failed.";
        await db.adminArbitrageProduct.updateMany({ where: { id: candidate.id, status: candidate.status || "PENDING" }, data: { status: "NO_MATCH", matchReason: `Automatic review could not finish: ${reason}` } });
        summary.failed++;
        summary.items.push({ id: candidate.id, asin: candidate.asin, outcome: "failed", reason });
      }
      summary.processed++;
    }
    summary.queued = await db.adminArbitrageProduct.count({ where });
    await db.adminCatalogReviewAutomation.update({ where: { id: "main" }, data: { lastRunAt: new Date(), lastSummaryJson: JSON.stringify(summary) } });
    return summary;
  } finally {
    await db.adminCatalogReviewAutomation.update({ where: { id: "main" }, data: { lockUntil: null } });
  }
}
