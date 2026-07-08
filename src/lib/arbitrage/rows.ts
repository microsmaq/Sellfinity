import "server-only";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { getArbitrageScanner } from "./index";
import { MAX_OPPORTUNITIES, type OpportunityRow } from "./scanner";

/** eBay item page host matching the connected environment. */
function ebayItemUrl(ebayListingId: string): string {
  const host =
    ebayEnvConfig()?.env === "PRODUCTION"
      ? "https://www.ebay.com"
      : "https://sandbox.ebay.com";
  return `${host}/itm/${ebayListingId}`;
}

export async function buildOpportunityRows(
  userId: string,
  count: number,
): Promise<OpportunityRow[]> {
  const capped = Math.min(count, MAX_OPPORTUNITIES);
  const [opportunities, products] = await Promise.all([
    getArbitrageScanner().findOpportunities(capped),
    db.product.findMany({
      where: { userId },
      select: {
        sku: true,
        listings: {
          orderBy: { updatedAt: "desc" },
          select: { ebayListingId: true, status: true },
        },
      },
    }),
  ]);

  // sku → the user's best listing link: prefer the ACTIVE one, fall back to
  // any published id; null when everything is still a draft.
  const owned = new Map<string, string | null>();
  for (const p of products) {
    const active = p.listings.find((l) => l.status === "ACTIVE" && l.ebayListingId);
    const published = active ?? p.listings.find((l) => l.ebayListingId);
    owned.set(p.sku, published?.ebayListingId ? ebayItemUrl(published.ebayListingId) : null);
  }

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
    mirrored: owned.has(o.amazon.asin),
    storeEbayUrl: owned.get(o.amazon.asin) ?? null,
  }));
}
