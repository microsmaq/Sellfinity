"use server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { catalogImportSchema } from "@/lib/arbitrage/catalog-import";

export async function filterCatalogImportAsins(rawAsins: string[]) {
  await requireAdmin();
  const asins = z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(1000).parse([...new Set(rawAsins)]);
  const existing = await db.adminArbitrageProduct.findMany({ where: { asin: { in: asins } }, select: { asin: true } });
  return { existing: existing.map((row) => row.asin) };
}

export async function importCatalogProducts(rawRows: unknown[], updateExisting = false) {
  const admin = await requireAdmin();
  const rows = z.array(catalogImportSchema).min(1).max(100).parse(rawRows);
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    // Transaction makes the skip-existing check and write atomic across
    // concurrent manual, browser and scheduled imports of the same ASIN.
    const outcome = await db.$transaction(async (tx) => {
      const existing = await tx.adminArbitrageProduct.findUnique({ where: { asin: row.asin } });
      if (existing && !updateExisting) return "skipped";
      const data = {
        amazonTitle: row.title, amazonBrand: row.brand, category: row.category,
        amazonUrl: `https://www.amazon.com/dp/${row.asin}`,
        amazonPriceCents: row.priceCents, amazonShippingCents: row.shippingCents ?? 0,
        amazonShippingVerified: row.shippingCents !== null,
        amazonInStock: row.availability === "AVAILABLE",
        amazonImageUrl: row.images[0] ?? null,
        amazonImageUrlsJson: JSON.stringify(row.images),
        amazonDescription: row.description,
        amazonBulletPointsJson: JSON.stringify(row.bulletPoints),
        amazonRefreshedAt: new Date(),
        isAmazonBestSeller: Boolean(row.bestsellerRank && row.bestsellerUrl),
        amazonImportDetailsJson: JSON.stringify({ ...row, importedAt: new Date().toISOString(), importedBy: admin.id }),
        status: "PENDING", matchVerdict: "UNVERIFIED", matchConfidence: 0,
        matchReason: "Imported Amazon source awaiting separate eBay research and approval.",
        matchMethod: "UNVERIFIED", ebayItemId: null, ebayTitle: null, ebayPriceCents: null,
        ebayUrl: null, ebayImageUrl: null, estimatedProfitCents: null, suggestedPriceCents: null,
        averageCompetitorPriceCents: null, ebayRecommendedPriceCents: null, estimatedSales30d: null,
        competitorCount: null, marginPct: null, lastResearchedAt: null,
      };
      await tx.adminArbitrageProduct.upsert({ where: { asin: row.asin }, create: { asin: row.asin, ...data }, update: data });
      return existing ? "updated" : "added";
    });
    if (outcome === "added") added++; else if (outcome === "updated") updated++; else skipped++;
  }
  revalidatePath("/admin/arbitrage");
  return { added, updated, skipped };
}
