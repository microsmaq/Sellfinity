import "server-only";
import { db } from "@/lib/db";
import { researchAdminCatalogProduct } from "./admin-research";
import { prioritizeCatalogReview } from "@/lib/ai/jev-workflows";

export async function catalogReviewSettings() {
  return db.adminCatalogReviewAutomation.upsert({ where: { id: "main" }, create: { id: "main" }, update: {} });
}

/** A database lease prevents overlapping cron/manual research batches. */
export async function runAutomaticCatalogReview(force = false) {
  const settings = await catalogReviewSettings();
  if (!settings.enabled && !force) return { skipped: true, reason: "Automatic review is disabled." };
  const now = new Date();
  const lease = await db.adminCatalogReviewAutomation.updateMany({
    where: { id: "main", OR: [{ lockUntil: null }, { lockUntil: { lt: now } }] },
    data: { lockUntil: new Date(now.getTime() + 15 * 60 * 1000) },
  });
  if (!lease.count) return { skipped: true, reason: "Another catalog review is running." };
  const summary = { processed: 0, published: 0, review: 0, failed: 0, queued: 0, items: [] as { asin: string; outcome: string; reason: string }[] };
  const deadline = Date.now() + 220_000;
  try {
    const where = {
      status: "PENDING", amazonInStock: true, amazonShippingVerified: true,
      amazonPriceCents: { gt: 0 }, lastResearchedAt: null,
      amazonRefreshedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    };
    const candidates = await db.adminArbitrageProduct.findMany({
      where, orderBy: { createdAt: "asc" }, take: settings.dailyLimit,
      select: { id: true, asin: true, amazonTitle: true, ebayTitle: true },
    });
    const prioritized = await prioritizeCatalogReview(candidates);
    for (const candidate of prioritized) {
      if (Date.now() + 90_000 > deadline) break;
      try {
        await researchAdminCatalogProduct(candidate.id, { automatic: true, ebayOnly: true });
        const result = await db.adminArbitrageProduct.findUnique({ where: { id: candidate.id }, select: { status: true, matchReason: true } });
        const published = result?.status === "PUBLISHED";
        if (published) summary.published++; else summary.review++;
        summary.items.push({ asin: candidate.asin, outcome: published ? "published" : "review", reason: result?.matchReason ?? "Manual review required." });
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 500) : "Automatic research failed.";
        await db.adminArbitrageProduct.updateMany({ where: { id: candidate.id, status: "PENDING" }, data: { status: "NO_MATCH", matchVerdict: "REVIEW", matchReason: `Automatic review could not finish: ${reason}`, lastResearchedAt: new Date() } });
        summary.failed++;
        summary.items.push({ asin: candidate.asin, outcome: "failed", reason });
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
