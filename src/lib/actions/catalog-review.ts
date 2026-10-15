"use server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { catalogReviewSettings, highConfidenceCatalogWhere, runAutomaticCatalogReview } from "@/lib/arbitrage/automatic-review";
import { jevConfiguration } from "@/lib/ai/jev";

const selectedApprovalIds = z.array(z.string().min(1).max(100)).min(1).max(5000).optional();

/** Snapshot a finite manual queue. Each checkpoint rechecks eligibility. */
export async function prepareCatalogAutoApproval(selectedIds: string[] | undefined, limit: number | "ALL"): Promise<{ skipped: true; reason: string } | { ids: string[] }> {
  await requireAdmin();
  const input = z.object({ ids: selectedApprovalIds, limit: z.union([z.number().int().min(1).max(100), z.literal("ALL")]) }).parse({ ids: selectedIds, limit });
  const config = jevConfiguration();
  if (!config.enabled || !config.configured) return { skipped: true as const, reason: "OpenAI Decisions is not enabled or configured. Check the Decisions connection in Admin Settings; no products were changed." };
  const rows = await db.adminArbitrageProduct.findMany({ where: highConfidenceCatalogWhere(new Date(), input.ids), orderBy: { updatedAt: "asc" }, ...(input.limit !== "ALL" && { take: input.limit }), select: { id: true } });
  return { ids: rows.map((row) => row.id) };
}

export async function saveCatalogReviewSettings(enabled: boolean, dailyLimit: number) {
  await requireAdmin();
  const input = z.object({ enabled: z.boolean(), dailyLimit: z.number().int().min(1).max(25) }).parse({ enabled, dailyLimit });
  await catalogReviewSettings();
  await db.adminCatalogReviewAutomation.update({ where: { id: "main" }, data: input });
  revalidatePath("/admin/settings");
  return { ok: true };
}
export async function reviewPendingCatalogNow() {
  await requireAdmin();
  const result = await runAutomaticCatalogReview(true);
  revalidatePath("/admin/arbitrage"); revalidatePath("/arbitrage"); revalidatePath("/admin/settings");
  return result;
}
export async function reviewHighConfidenceCatalogNow(selectedIds?: string[], limit?: number) {
  await requireAdmin();
  const input = z.object({ ids: selectedApprovalIds, limit: z.number().int().min(1).max(25).optional() }).parse({ ids: selectedIds, limit });
  const config = jevConfiguration();
  if (!config.enabled || !config.configured) return { skipped: true as const, reason: "OpenAI Decisions is not enabled or configured. Check the Decisions connection in Admin Settings; no products were changed." };
  const result = await runAutomaticCatalogReview(true, true, input);
  revalidatePath("/admin/arbitrage"); revalidatePath("/arbitrage"); revalidatePath("/admin/settings");
  return result;
}
