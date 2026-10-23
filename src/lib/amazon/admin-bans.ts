import { db } from "@/lib/db";

/** Read the durable ASIN ban even if another importer refreshed the snapshot. */
export async function bannedAmazonAsins(): Promise<Set<string>> {
  const rows = await db.adminArbitrageProduct.findMany({
    where: { bannedAt: { not: null } }, select: { asin: true },
  });
  return new Set(rows.map((row) => row.asin.trim().toUpperCase()));
}
