"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { researchAdminCatalogProduct } from "@/lib/arbitrage/admin-research";

export async function prepareCatalogEquivalentResearch(selectedIds?: string[]) {
  await requireAdmin();
  const ids = selectedIds ? z.array(z.string().min(1).max(100)).min(1).max(5000).parse([...new Set(selectedIds)]) : null;
  const rows = await db.adminArbitrageProduct.findMany({
    where: {
      status: ids ? { in: ["PENDING", "NO_MATCH"] } : "PENDING",
      ...(ids && { id: { in: ids } }),
      amazonInStock: true, amazonShippingVerified: true, amazonPriceCents: { gt: 0 },
    },
    orderBy: [{ lastResearchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true },
  });
  return { ids: rows.map((row) => row.id) };
}

/** One product per checkpoint; never purchase Amazon data or publish here. */
export async function researchCatalogEquivalent(id: string) {
  await requireAdmin();
  const parsed = z.string().min(1).max(100).parse(id);
  const item = await db.adminArbitrageProduct.findUnique({ where: { id: parsed }, select: { status: true, amazonTitle: true } });
  if (!item || !["PENDING", "NO_MATCH"].includes(item.status)) return { ok: true, outcome: "skipped" as const, title: item?.amazonTitle ?? "Product", message: "Already approved or no longer eligible.", pause: false };
  try {
    await researchAdminCatalogProduct(parsed, { storedSource: true, ebayOnly: true, reviewOnly: true });
    const saved = await db.adminArbitrageProduct.findUnique({ where: { id: parsed }, select: { ebayItemId: true, matchReason: true } });
    revalidatePath("/admin/arbitrage");
    return { ok: true, outcome: saved?.ebayItemId ? "matched" as const : "unmatched" as const, title: item.amazonTitle, message: saved?.matchReason || "No equivalent found.", pause: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Research could not complete.";
    const pause = /\b(?:401|403|429|50[0234])\b|not configured|access denied|too many requests|rate.?limit|usage limit/i.test(message);
    return { ok: false, outcome: "error" as const, title: item.amazonTitle, message, pause };
  }
}
