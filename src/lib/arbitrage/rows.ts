import "server-only";
import { db } from "@/lib/db";
import { getArbitrageScanner } from "./index";
import { MAX_OPPORTUNITIES, type OpportunityRow } from "./scanner";

export async function buildOpportunityRows(
  userId: string,
  count: number,
): Promise<OpportunityRow[]> {
  const capped = Math.min(count, MAX_OPPORTUNITIES);
  const [opportunities, products] = await Promise.all([
    getArbitrageScanner().findOpportunities(capped),
    db.product.findMany({ where: { userId }, select: { sku: true } }),
  ]);
  const ownedSkus = new Set(products.map((p) => p.sku));

  return opportunities.map((o) => ({
    asin: o.amazon.asin,
    category: o.category,
    title: o.ebay.title,
    imageUrl: o.ebay.imageUrl,
    ebayPriceCents: o.ebay.priceCents,
    ebaySales30d: o.ebay.salesLast30d,
    ebayUrl: o.ebay.url,
    amazonPriceCents: o.amazon.priceCents,
    amazonUrl: o.amazon.url,
    profitCents: o.margin.estimatedProfitCents,
    marginPct: Math.round(o.margin.marginPct),
    feeCents: o.margin.estimatedFeeCents,
    mirrored: ownedSkus.has(o.amazon.asin),
  }));
}
