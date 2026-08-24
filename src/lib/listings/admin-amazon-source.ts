import "server-only";

import { db } from "@/lib/db";
import { getSharedAmazonProduct } from "@/lib/mirror/shared-catalog";

/**
 * Return the global admin Amazon snapshot, buying at most the first missing
 * provider lookup. Rainforest's durable request lease deduplicates concurrent
 * first requests; the completed snapshot is then reused by every seller.
 */
export async function getAdminAmazonSourceWithFallback(rawAsin: string) {
  const asin = rawAsin.trim().toUpperCase();
  let source = await db.adminArbitrageProduct.findUnique({ where: { asin } });
  if (source && source.amazonPriceCents > 0) return { ...source, sharedCatalogPopulated: false };

  const populated = await getSharedAmazonProduct(asin, { providerOnCatalogMiss: true });
  if (!populated) {
    throw new Error(`Amazon data could not be retrieved for ASIN ${asin}. Rainforest returned no purchasable product data.`);
  }
  source = await db.adminArbitrageProduct.findUnique({ where: { asin } });
  if (!source || source.amazonPriceCents <= 0) {
    throw new Error(`Amazon data for ASIN ${asin} could not be saved to the administrator catalog.`);
  }
  return { ...source, sharedCatalogPopulated: true };
}
