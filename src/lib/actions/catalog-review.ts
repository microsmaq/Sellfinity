"use server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { catalogReviewSettings, runAutomaticCatalogReview } from "@/lib/arbitrage/automatic-review";

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
