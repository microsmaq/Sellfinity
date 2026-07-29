import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import type { ArbitrageOpportunity, OpportunityRow } from "./scanner";
import { estimateMargin } from "@/lib/fees";
import { syncAdminCatalogFromOpportunities } from "./admin-catalog";
import { arbitrageSuggestedPriceCents } from "./pricing";

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

  const toData = (o: ArbitrageOpportunity) => {
    // Real scans always supply the verifier result. Other scanner
    // implementations own the identity of their synthetic/pre-matched rows.
    const match = o.match ?? {
      verdict: "MATCH" as const,
      confidence: 100,
      reason: "The scanner supplied an already paired catalog product.",
      method: "RULES" as const,
    };
    const suggestedPrice = arbitrageSuggestedPriceCents(
      o.amazon.priceCents,
      o.ebay.priceCents,
      o.market?.bestSellingPriceCents,
      o.market?.averageCompetitorPriceCents ?? o.ebay.priceCents,
      o.amazon.shippingCostCents,
    );
    const projectedMargin = estimateMargin(
      suggestedPrice,
      o.amazon.priceCents,
      o.amazon.shippingCostCents,
    );
    return {
      ebayTitle: o.ebay.title,
      ebayPriceCents: o.ebay.priceCents,
      ebayUrl: o.ebay.url,
      imageUrl: o.ebay.imageUrl,
      category: o.category,
      asin: o.amazon.asin,
      amazonTitle: o.amazon.title,
      amazonPriceCents: o.amazon.priceCents,
      amazonShippingCents: o.amazon.shippingCostCents,
      amazonUrl: o.amazon.url,
      profitCents: projectedMargin.estimatedProfitCents,
      marginPct: Math.round(projectedMargin.marginPct),
      feeCents: projectedMargin.estimatedFeeCents,
      salesEst: o.market?.estimatedSales30d ?? o.ebay.salesLast30d,
      competitorCount: o.market?.competitorCount,
      avgCompPriceCents: o.market?.averageCompetitorPriceCents,
      bestSellingPriceCents: o.market?.bestSellingPriceCents,
      matchVerdict: match.verdict,
      matchConfidence: match.confidence,
      matchReason: match.reason,
      matchMethod: match.method,
      matchCheckedAt: new Date(),
    };
  };

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
  await syncAdminCatalogFromOpportunities([...byId.values()]);
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
    | "recommendedPrice"
    | "suggestedPrice"
    | "matchConfidence"
    | "usersListed"
    | "researched"
    | "amazonTitle"
    | "category"
    | "newest";
  sortDesc: boolean;
  category: string; // "all" or a category name
  minMarginPct: number;
  minConfidence?: number;
  matchVerdict?: "ALL" | "MATCH" | "LIKELY" | "REVIEW";
  qualifiedOnly?: boolean;
  query: string;
};

export type ArbitragePage = {
  rows: OpportunityRow[];
  total: number;
  page: number;
  pageCount: number;
  categories: string[];
  counts: {
    published: number;
    qualified: number;
    listedByUser: number;
    hiddenByUser: number;
  };
};

const SORT_COLUMNS: Record<
  Exclude<ArbitragePageParams["sortKey"], "usersListed">,
  keyof Prisma.AdminArbitrageProductOrderByWithRelationInput
> = {
  profit: "estimatedProfitCents",
  margin: "marginPct",
  ebayPrice: "ebayPriceCents",
  amazonPrice: "amazonPriceCents",
  sales: "estimatedSales30d",
  competition: "competitorCount",
  avgCompPrice: "averageCompetitorPriceCents",
  recommendedPrice: "ebayRecommendedPriceCents",
  suggestedPrice: "suggestedPriceCents",
  matchConfidence: "matchConfidence",
  researched: "lastResearchedAt",
  amazonTitle: "amazonTitle",
  category: "category",
  newest: "updatedAt",
};

function orderBy(params: ArbitragePageParams) {
  const key = params.sortKey === "usersListed" ? "newest" : params.sortKey;
  const column = SORT_COLUMNS[key] ?? SORT_COLUMNS.profit;
  const direction = params.sortDesc ? "desc" : "asc";
  const nullable = [
    "ebayPriceCents",
    "estimatedSales30d",
    "competitorCount",
    "averageCompetitorPriceCents",
    "ebayRecommendedPriceCents",
    "suggestedPriceCents",
    "estimatedProfitCents",
    "marginPct",
    "lastResearchedAt",
  ].includes(column);
  return {
    [column]: nullable ? { sort: direction, nulls: "last" } : direction,
  } as Prisma.AdminArbitrageProductOrderByWithRelationInput;
}

/** One page of the research database, with the user's ownership flags. */
export async function listArbitragePage(
  userId: string,
  params: ArbitragePageParams,
): Promise<ArbitragePage> {
  const hiddenRows = await db.hiddenArbitrageItem.findMany({
    where: { userId },
    select: { ebayItemId: true },
  });
  const hiddenIds = hiddenRows.map((row) => row.ebayItemId);
  const matchVerdict = params.matchVerdict ?? "ALL";
  const query = params.query.trim();
  const where: Prisma.AdminArbitrageProductWhereInput = {
    status: "PUBLISHED",
    ebayItemId: { not: null, ...(hiddenIds.length && { notIn: hiddenIds }) },
    ...(params.category !== "all" && { category: params.category }),
    ...(params.minMarginPct > 0 && { marginPct: { gte: params.minMarginPct } }),
    ...((params.minConfidence ?? 0) > 0 && {
      matchConfidence: { gte: params.minConfidence },
    }),
    ...(matchVerdict !== "ALL"
      ? { matchVerdict }
      : { matchVerdict: { in: ["MATCH", "LIKELY", "REVIEW"] } }),
    ...(params.qualifiedOnly && {
      matchVerdict: { in: ["MATCH", "LIKELY"] },
      matchConfidence: { gte: 95 },
      marginPct: { gte: 15 },
      estimatedProfitCents: { gt: 0 },
      suggestedPriceCents: { not: null },
    }),
    ...(query && {
      OR: [
        { asin: { contains: query, mode: "insensitive" } },
        { amazonTitle: { contains: query, mode: "insensitive" } },
        { ebayTitle: { contains: query, mode: "insensitive" } },
        { ebayItemId: { contains: query, mode: "insensitive" } },
        { category: { contains: query, mode: "insensitive" } },
        { matchReason: { contains: query, mode: "insensitive" } },
      ],
    }),
  };
  const pageSize = [25, 50, 100].includes(params.pageSize ?? DEFAULT_PAGE_SIZE)
    ? (params.pageSize ?? DEFAULT_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const [total, publishedRows, qualified, categoryRows] = await Promise.all([
    db.adminArbitrageProduct.count({ where }),
    db.adminArbitrageProduct.findMany({
      where: { status: "PUBLISHED", ebayItemId: { not: null } },
      select: { asin: true },
    }),
    db.adminArbitrageProduct.count({
      where: {
        status: "PUBLISHED",
        ebayItemId: { not: null },
        matchVerdict: { in: ["MATCH", "LIKELY"] },
        matchConfidence: { gte: 95 },
        marginPct: { gte: 15 },
        estimatedProfitCents: { gt: 0 },
      },
    }),
    db.adminArbitrageProduct.findMany({
      where: { status: "PUBLISHED" },
      distinct: ["category"],
      select: { category: true },
      orderBy: { category: "asc" },
    }),
  ]);

  let items = await db.adminArbitrageProduct.findMany({
    where,
    orderBy: orderBy(params),
    ...(params.sortKey === "usersListed"
      ? {}
      : {
          skip: (Math.max(1, params.page) - 1) * pageSize,
          take: pageSize,
        }),
  });

  const adoptionAsins = items.map((item) => item.asin);
  const activeProducts = adoptionAsins.length
    ? await db.product.findMany({
        where: {
          sku: { in: adoptionAsins },
          listings: { some: { status: "ACTIVE" } },
        },
        select: { sku: true, userId: true },
      })
    : [];
  const usersByAsin = new Map<string, Set<string>>();
  for (const product of activeProducts) {
    const users = usersByAsin.get(product.sku) ?? new Set<string>();
    users.add(product.userId);
    usersByAsin.set(product.sku, users);
  }
  if (params.sortKey === "usersListed") {
    items.sort((a, b) => {
      const difference =
        (usersByAsin.get(a.asin)?.size ?? 0) -
        (usersByAsin.get(b.asin)?.size ?? 0);
      if (difference !== 0) return params.sortDesc ? -difference : difference;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    const start = (Math.max(1, params.page) - 1) * pageSize;
    items = items.slice(start, start + pageSize);
  }

  // Ownership: which of this page's ASINs the user already sells.
  const asins = items.map((i) => i.asin);
  const [products, researchRows, listedByUser] = await Promise.all([
    db.product.findMany({
      where: { userId, sku: { in: asins } },
      select: {
        sku: true,
        listings: {
          orderBy: { updatedAt: "desc" },
          select: { ebayListingId: true, status: true },
        },
      },
    }),
    db.arbitrageItem.findMany({
      where: {
        ebayItemId: {
          in: items.flatMap((item) => item.ebayItemId ?? []),
        },
      },
      select: {
        ebayItemId: true,
        feeCents: true,
        matchMethod: true,
        createdAt: true,
      },
    }),
    db.product.count({
      where: {
        userId,
        sku: { in: publishedRows.map((item) => item.asin) },
        listings: { some: { status: "ACTIVE" } },
      },
    }),
  ]);
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
  const researchById = new Map(
    researchRows.map((row) => [row.ebayItemId, row]),
  );

  return {
    rows: items.map((i) => ({
      asin: i.asin,
      ebayItemId: i.ebayItemId ?? "",
      category: i.category,
      title: i.ebayTitle ?? i.amazonTitle,
      imageUrl: i.ebayImageUrl ?? i.amazonImageUrl ?? "",
      ebayPriceCents: i.ebayPriceCents ?? 0,
      ebaySales30d: i.estimatedSales30d ?? 0,
      competitorCount: i.competitorCount,
      avgCompPriceCents: i.averageCompetitorPriceCents,
      suggestedListingPriceCents:
        i.suggestedPriceCents ??
        arbitrageSuggestedPriceCents(
          i.amazonPriceCents,
          i.ebayPriceCents ?? 0,
          i.ebayRecommendedPriceCents,
          i.averageCompetitorPriceCents ?? i.ebayPriceCents ?? 0,
          i.amazonShippingCents,
        ),
      ebayUrl: i.ebayUrl ?? "",
      amazonPriceCents: i.amazonPriceCents,
      amazonShippingCents: i.amazonShippingCents,
      amazonUrl: i.amazonUrl,
      profitCents: i.estimatedProfitCents ?? 0,
      marginPct: i.marginPct ?? 0,
      feeCents: researchById.get(i.ebayItemId ?? "")?.feeCents ?? 0,
      mirrored: owned.has(i.asin),
      storeEbayUrl: owned.get(i.asin) ?? null,
      foundAt:
        researchById.get(i.ebayItemId ?? "")?.createdAt.toISOString() ??
        i.createdAt.toISOString(),
      amazonTitle: i.amazonTitle,
      amazonImageUrl: i.amazonImageUrl,
      isAmazonBestSeller: i.isAmazonBestSeller,
      ebayRecommendedPriceCents: i.ebayRecommendedPriceCents,
      usersListed: usersByAsin.get(i.asin)?.size ?? 0,
      lastResearchedAt: i.lastResearchedAt?.toISOString() ?? null,
      matchVerdict: i.matchVerdict,
      matchConfidence: i.matchConfidence,
      matchReason: i.matchReason,
      matchMethod: researchById.get(i.ebayItemId ?? "")?.matchMethod ?? "ADMIN",
    })),
    total,
    page: Math.max(1, params.page),
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    categories: categoryRows.map((c) => c.category),
    counts: {
      published: publishedRows.length,
      qualified,
      listedByUser,
      hiddenByUser: hiddenIds.length,
    },
  };
}
