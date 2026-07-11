import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import type { ArbitrageOpportunity, OpportunityRow } from "./scanner";
import { suggestedListingPriceCents } from "@/lib/listings/cleanup";

/** Upsert scanned opportunities into the shared research database.
 * Batched: one lookup + one createMany for new rows, individual updates
 * only for repeats (rare). Returns how many were genuinely new. */
export async function persistOpportunities(
  opportunities: ArbitrageOpportunity[],
): Promise<number> {
  if (opportunities.length === 0) return 0;
  // Dedupe within the batch (last one wins), then split new vs. existing.
  const byId = new Map(opportunities.map((o) => [o.ebay.itemId, o]));
  const ids = [...byId.keys()];
  const existing = new Set(
    (
      await db.arbitrageItem.findMany({
        where: { ebayItemId: { in: ids } },
        select: { ebayItemId: true },
      })
    ).map((r) => r.ebayItemId),
  );

  const toData = (o: ArbitrageOpportunity) => ({
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
  });

  const fresh = [...byId.values()].filter((o) => !existing.has(o.ebay.itemId));
  if (fresh.length > 0) {
    await db.arbitrageItem.createMany({
      data: fresh.map((o) => ({ ebayItemId: o.ebay.itemId, ...toData(o) })),
      skipDuplicates: true,
    });
  }
  for (const o of [...byId.values()].filter((o) => existing.has(o.ebay.itemId))) {
    await db.arbitrageItem.update({
      where: { ebayItemId: o.ebay.itemId },
      data: toData(o),
    });
  }
  return fresh.length;
}

export const DEFAULT_PAGE_SIZE = 25;

export type ArbitragePageParams = {
  page: number; // 1-based
  pageSize?: number;
  sortKey:
    | "profit"
    | "margin"
    | "ebayPrice"
    | "amazonPrice"
    | "sales"
    | "competition"
    | "avgCompPrice"
    | "newest";
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

const SORT_COLUMNS: Record<ArbitragePageParams["sortKey"], string> = {
  profit: "profitCents",
  margin: "marginPct",
  ebayPrice: "ebayPriceCents",
  amazonPrice: "amazonPriceCents",
  sales: "salesEst",
  competition: "competitorCount",
  avgCompPrice: "avgCompPriceCents",
  newest: "createdAt",
};

function orderBy(params: ArbitragePageParams) {
  const column = SORT_COLUMNS[params.sortKey] ?? SORT_COLUMNS.profit;
  const direction = params.sortDesc ? "desc" : "asc";
  const nullable = column === "competitorCount" || column === "avgCompPriceCents";
  return {
    [column]: nullable ? { sort: direction, nulls: "last" } : direction,
  } as Prisma.ArbitrageItemOrderByWithRelationInput;
}

/** One page of the research database, with the user's ownership flags. */
export async function listArbitragePage(
  userId: string,
  params: ArbitragePageParams,
): Promise<ArbitragePage> {
  const where: Prisma.ArbitrageItemWhereInput = {
    hiddenBy: { none: { userId } },
    ...(params.category !== "all" && { category: params.category }),
    ...(params.minMarginPct > 0 && { marginPct: { gte: params.minMarginPct } }),
    ...(params.query.trim() && {
      ebayTitle: { contains: params.query.trim(), mode: "insensitive" },
    }),
  };
  const pageSize = [25, 50, 100].includes(params.pageSize ?? DEFAULT_PAGE_SIZE)
    ? (params.pageSize ?? DEFAULT_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const [total, items, categoryRows] = await Promise.all([
    db.arbitrageItem.count({ where }),
    db.arbitrageItem.findMany({
      where,
      orderBy: orderBy(params),
      skip: (Math.max(1, params.page) - 1) * pageSize,
      take: pageSize,
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
      ebayItemId: i.ebayItemId,
      category: i.category,
      title: i.ebayTitle,
      imageUrl: i.imageUrl,
      ebayPriceCents: i.ebayPriceCents,
      ebaySales30d: i.salesEst,
      competitorCount: i.competitorCount,
      avgCompPriceCents: i.avgCompPriceCents,
      suggestedListingPriceCents: suggestedListingPriceCents(
        i.amazonPriceCents,
        0,
        i.avgCompPriceCents ?? i.ebayPriceCents,
      ),
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
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    categories: categoryRows.map((c) => c.category),
  };
}
