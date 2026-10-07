"use server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { catalogImportSchema } from "@/lib/arbitrage/catalog-import";
import { catalogStringArray, catalogContentWarnings } from "@/lib/arbitrage/catalog-content";

export async function prepareCatalogContentRepair(limit: number) {
  await requireAdmin();
  const take = z.number().int().min(1).max(1000).parse(limit);
  const rows = await db.adminArbitrageProduct.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, asin: true, amazonTitle: true, amazonDescription: true, amazonBulletPointsJson: true, amazonImageUrlsJson: true, amazonImageUrl: true, amazonImportDetailsJson: true, createdAt: true } });
  const attempted = (value: string) => { try { return Date.parse(JSON.parse(value || "{}").contentCheckedAt) || 0; } catch { return 0; } };
  return { candidates: rows.filter((row) => catalogContentWarnings(row).length > 0).sort((a, b) => attempted(a.amazonImportDetailsJson) - attempted(b.amazonImportDetailsJson) || a.createdAt.getTime() - b.createdAt.getTime()).slice(0, take).map((row) => ({ id: row.id, asin: row.asin, amazonUrl: `https://www.amazon.com/dp/${row.asin}` })) };
}

export async function recordCatalogContentCheck(id: string) {
  await requireAdmin();
  const parsed = z.string().min(1).max(100).parse(id);
  const row = await db.adminArbitrageProduct.findUnique({ where: { id: parsed } });
  if (!row || row.status === "ARCHIVED") return;
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(row.amazonImportDetailsJson || "{}"); } catch { /* Preserve a usable audit object. */ }
  await db.adminArbitrageProduct.updateMany({ where: { id: parsed, updatedAt: row.updatedAt }, data: { amazonImportDetailsJson: JSON.stringify({ ...details, contentCheckedAt: new Date().toISOString() }) } });
}

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
      if (existing && !updateExisting) {
        // Enrich content only. Never reset an approved match, prices or stock.
        const oldImages = catalogStringArray(existing.amazonImageUrlsJson);
        const images = [...new Set([...oldImages, ...(existing.amazonImageUrl ? [existing.amazonImageUrl] : []), ...row.images])].slice(0, 12);
        const description = existing.amazonDescription?.trim() && existing.amazonDescription.trim() !== existing.amazonTitle?.trim() ? existing.amazonDescription : row.description;
        const bullets = catalogStringArray(existing.amazonBulletPointsJson).length ? catalogStringArray(existing.amazonBulletPointsJson) : row.bulletPoints;
        const changed = Boolean(description && description !== existing.amazonDescription) || (bullets.length > 0 && JSON.stringify(bullets) !== (existing.amazonBulletPointsJson || "[]")) || images.some((image) => !oldImages.includes(image));
        if (!changed) return "skipped";
        await tx.adminArbitrageProduct.update({ where: { asin: row.asin }, data: {
          amazonDescription: description || existing.amazonDescription || "",
          amazonBulletPointsJson: JSON.stringify(bullets),
          amazonImageUrl: existing.amazonImageUrl || images[0] || null,
          amazonImageUrlsJson: JSON.stringify(images),
        } });
        return "updated";
      }
      const data = {
        amazonTitle: row.title, amazonBrand: row.brand, category: row.category,
        amazonUrl: `https://www.amazon.com/dp/${row.asin}`,
        amazonPriceCents: row.priceCents, amazonShippingCents: row.shippingCents ?? 0,
        amazonShippingVerified: row.shippingCents !== null,
        amazonInStock: row.availability === "AVAILABLE",
        amazonImageUrl: row.images[0] ?? existing?.amazonImageUrl ?? null,
        amazonImageUrlsJson: JSON.stringify(row.images.length ? row.images : catalogStringArray(existing?.amazonImageUrlsJson)),
        amazonDescription: row.description || existing?.amazonDescription || "",
        amazonBulletPointsJson: JSON.stringify(row.bulletPoints.length ? row.bulletPoints : catalogStringArray(existing?.amazonBulletPointsJson)),
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
