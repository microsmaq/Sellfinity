import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import type { ArbitrageOpportunity, OpportunityRow } from "./scanner";

/** Upsert scanned opportunities into the shared research database. */
export async function persistOpportunities(
  opportunities: ArbitrageOpportunity[],
): Promise<number> {
  let added = 0;
  for (const o of opportunities) {
    const data = {
      ebayTitle: o.ebay.title,
      ebayPriceCents: o.ebay.priceCents,
      ebayUrl: o.ebay.url,
      imageUrl: o.ebay.imageUrl,
      category: o.category,
      asin: o.amazon.asin,
      amazonTitle: o.amazon.title,
      amazonPriceCents: o.amazon.priceCents,
      amazonUrl: o.amazon.url,
      profitCents: o.margin.estimatedProfitCents,
      marginPct: Math.round(o.margin.marginPct),
      feeCents: o.margin.estimatedFeeCents,
      salesEst: o.ebay.salesLast30d,
    };
    const existing = await db.arbitrageItem.findUnique({
      where: { ebayItemId: o.ebay.itemId },
      select: { id: true },
    });
    if (existing) {
      await db.arbitrageItem.update({ where: { id: existing.id }, data });
    } else {
      await db.arbitrageItem.create({ data: { ebayItemId: o.ebay.itemId, ...data } });
      added++;
    }
  }
  return added;
}

export const PAGE_SIZE = 25;

export type ArbitragePageParams = {
  page: number; // 1-based
  sortKey: "profit" | "margin" | "ebayPrice" | "amazonPrice" | "sales" | "newest";
  sortDesc: boolean;
  category: string; // "all" or a category name
  minMarginPct: number;
  query: string;
};

export type ArbitragePage = {
  rows: OpportunityRow[];
  total: number;
  page: number;
  pageCount: number;
  categories: string[];
};

const SORT_COLUMNS: Record<ArbitragePageParams["sortKey"], Prisma.ArbitrageItemOrderByWithRelationInput> = {
  profit: { profitCents: "desc" },
  margin: { marginPct: "desc" },
  ebayPrice: { ebayPriceCents: "desc" },
  amazonPrice: { amazonPriceCents: "desc" },
  sales: { salesEst: "desc" },
  newest: { createdAt: "desc" },
};

function orderBy(params: ArbitragePageParams) {
  const base = SORT_COLUMNS[params.sortKey] ?? SORT_COLUMNS.profit;
  const [[column]] = Object.entries(base);
  return { [column]: params.sortDesc ? "desc" : "asc" } as Prisma.ArbitrageItemOrderByWithRelationInput;
}

/** One page of the research database, with the user's ownership flags. */
export async function listArbitragePage(
  userId: string,
  params: ArbitragePageParams,
): Promise<ArbitragePage> {
  const where: Prisma.ArbitrageItemWhereInput = {
    ...(params.category !== "all" && { category: params.category }),
    ...(params.minMarginPct > 0 && { marginPct: { gte: params.minMarginPct } }),
    ...(params.query.trim() && {
      ebayTitle: { contains: params.query.trim(), mode: "insensitive" },
    }),
  };

  const [total, items, categoryRows] = await Promise.all([
    db.arbitrageItem.count({ where }),
    db.arbitrageItem.findMany({
      where,
      orderBy: orderBy(params),
      skip: (Math.max(1, params.page) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.arbitrageItem.findMany({
      distinct: ["category"],
      select: { category: true },
      orderBy: { category: "asc" },
    }),
  ]);

  // Ownership: which of this page's ASINs the user already sells.
  const asins = items.map((i) => i.asin);
  const products = await db.product.findMany({
    where: { userId, sku: { in: asins } },
    select: {
      sku: true,
      listings: {
        orderBy: { updatedAt: "desc" },
        select: { ebayListingId: true, status: true },
      },
    },
  });
  const itemHost =
    ebayEnvConfig()?.env === "PRODUCTION"
      ? "https://www.ebay.com"
      : "https://sandbox.ebay.com";
  const owned = new Map<string, string | null>();
  for (const p of products) {
    const active = p.listings.find((l) => l.status === "ACTIVE" && l.ebayListingId);
    const published = active ?? p.listings.find((l) => l.ebayListingId);
    owned.set(
      p.sku,
      published?.ebayListingId ? `${itemHost}/itm/${published.ebayListingId}` : null,
    );
  }

  return {
    rows: items.map((i) => ({
      asin: i.asin,
      category: i.category,
      title: i.ebayTitle,
      imageUrl: i.imageUrl,
      ebayPriceCents: i.ebayPriceCents,
      ebaySales30d: i.salesEst,
      ebayUrl: i.ebayUrl,
      amazonPriceCents: i.amazonPriceCents,
      amazonUrl: i.amazonUrl,
      profitCents: i.profitCents,
      marginPct: i.marginPct,
      feeCents: i.feeCents,
      mirrored: owned.has(i.asin),
      storeEbayUrl: owned.get(i.asin) ?? null,
      foundAt: i.createdAt.toISOString(),
    })),
    total,
    page: Math.max(1, params.page),
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    categories: categoryRows.map((c) => c.category),
  };
}
