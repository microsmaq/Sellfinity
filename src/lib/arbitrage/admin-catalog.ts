import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import type { ArbitrageOpportunity } from "./scanner";
import { arbitrageSuggestedPriceCents } from "./pricing";
import {
  assessPriceCompetitiveness,
  isCompetitivelyPriced,
} from "./price-competitiveness";
import {
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
  AUTO_PUBLISH_FLAT_PROFIT_CENTS,
} from "./auto-publish";

export const ADMIN_CATALOG_PAGE_SIZE = 50;

export type AdminCatalogStatus =
  | "ALL"
  | "PENDING"
  | "PUBLISHED"
  | "NO_MATCH"
  | "ARCHIVED";

export type AdminCatalogSortKey =
  | "newest"
  | "amazonTitle"
  | "category"
  | "amazonPrice"
  | "ebayPrice"
  | "matchConfidence"
  | "averagePrice"
  | "recommendedPrice"
  | "suggestedPrice"
  | "sales"
  | "competition"
  | "profit"
  | "margin"
  | "usersListed"
  | "researched";

export type AdminCatalogFilters = {
  query: string;
  status: AdminCatalogStatus;
  category: string;
  matchVerdict: string;
  source: "ALL" | "BESTSELLER" | "ADMIN";
  ebayMatch: "ALL" | "MATCHED" | "UNMATCHED";
  minMargin: number;
  minConfidence: number;
  qualifiedOnly: boolean;
  sortKey: AdminCatalogSortKey;
  sortDesc: boolean;
  pageSize: number;
};

export type AdminCatalogRow = {
  id: string;
  asin: string;
  amazonTitle: string;
  amazonPriceCents: number;
  amazonShippingCents: number;
  amazonUrl: string;
  amazonImageUrl: string | null;
  category: string;
  isAmazonBestSeller: boolean;
  status: string;
  ebayItemId: string | null;
  ebayTitle: string | null;
  ebayPriceCents: number | null;
  ebayUrl: string | null;
  ebayImageUrl: string | null;
  matchVerdict: string;
  matchConfidence: number;
  matchReason: string | null;
  estimatedSales30d: number | null;
  competitorCount: number | null;
  averageCompetitorPriceCents: number | null;
  ebayRecommendedPriceCents: number | null;
  suggestedPriceCents: number | null;
  estimatedProfitCents: number | null;
  marginPct: number | null;
  usersListed: number;
  lastResearchedAt: string | null;
  updatedAt: string;
};

export type AdminCatalogPage = {
  rows: AdminCatalogRow[];
  total: number;
  page: number;
  pageCount: number;
  categories: string[];
  counts: Record<"all" | "published" | "pending" | "noMatch" | "archived", number>;
};

function suggestedPriceFor(item: {
  amazonPriceCents: number;
  amazonShippingCents: number;
  ebayPriceCents: number | null;
  ebayRecommendedPriceCents: number | null;
  averageCompetitorPriceCents: number | null;
}): number | null {
  return item.ebayPriceCents
    ? arbitrageSuggestedPriceCents(
        item.amazonPriceCents,
        item.ebayPriceCents,
        item.ebayRecommendedPriceCents,
        item.averageCompetitorPriceCents ?? item.ebayPriceCents,
        item.amazonShippingCents,
      )
    : null;
}

function hasCompetitiveSuggestedPrice(item: {
  amazonPriceCents: number;
  amazonShippingCents: number;
  ebayPriceCents: number | null;
  ebayRecommendedPriceCents: number | null;
  averageCompetitorPriceCents: number | null;
}): boolean {
  const suggestedPrice = suggestedPriceFor(item);
  return suggestedPrice !== null && isCompetitivelyPriced(
    assessPriceCompetitiveness(
      suggestedPrice,
      item.ebayPriceCents ?? 0,
      item.averageCompetitorPriceCents,
      item.ebayRecommendedPriceCents,
    ),
  );
}

export async function listAdminCatalog(params: {
  page: number;
  filters: AdminCatalogFilters;
}): Promise<AdminCatalogPage> {
  const page = Math.max(1, params.page);
  const filters = params.filters;
  const query = filters.query.trim();
  const pageSize = [25, 50, 100].includes(filters.pageSize)
    ? filters.pageSize
    : ADMIN_CATALOG_PAGE_SIZE;
  const where: Prisma.AdminArbitrageProductWhereInput = {
    ...(filters.status !== "ALL" && { status: filters.status }),
    ...(filters.category !== "ALL" && { category: filters.category }),
    ...(filters.matchVerdict !== "ALL" && {
      matchVerdict: filters.matchVerdict,
    }),
    ...(filters.source === "BESTSELLER" && { isAmazonBestSeller: true }),
    ...(filters.source === "ADMIN" && { isAmazonBestSeller: false }),
    ...(filters.ebayMatch === "MATCHED" && { ebayItemId: { not: null } }),
    ...(filters.ebayMatch === "UNMATCHED" && { ebayItemId: null }),
    ...(filters.minMargin > 0 && { marginPct: { gte: filters.minMargin } }),
    ...(filters.minConfidence > 0 && {
      matchConfidence: { gte: filters.minConfidence },
    }),
    ...(filters.qualifiedOnly && {
      AND: [
        {
          ebayItemId: { not: null },
          suggestedPriceCents: { not: null },
          matchVerdict: { in: ["MATCH", "LIKELY"] },
          matchConfidence: { gte: AUTO_PUBLISH_MIN_MATCH_CONFIDENCE },
          OR: [
            { marginPct: { gte: AUTO_PUBLISH_MIN_MARGIN_PCT } },
            { estimatedProfitCents: { gte: AUTO_PUBLISH_FLAT_PROFIT_CENTS } },
          ],
          estimatedProfitCents: { gt: 0 },
        },
      ],
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

  const scalarSortFields: Partial<
    Record<AdminCatalogSortKey, keyof Prisma.AdminArbitrageProductOrderByWithRelationInput>
  > = {
    newest: "updatedAt",
    amazonTitle: "amazonTitle",
    category: "category",
    amazonPrice: "amazonPriceCents",
    ebayPrice: "ebayPriceCents",
    matchConfidence: "matchConfidence",
    averagePrice: "averageCompetitorPriceCents",
    recommendedPrice: "ebayRecommendedPriceCents",
    suggestedPrice: "suggestedPriceCents",
    sales: "estimatedSales30d",
    competition: "competitorCount",
    profit: "estimatedProfitCents",
    margin: "marginPct",
    researched: "lastResearchedAt",
  };
  const sortField = scalarSortFields[filters.sortKey] ?? "updatedAt";
  const nullableSortFields = new Set([
    "ebayPriceCents",
    "averageCompetitorPriceCents",
    "ebayRecommendedPriceCents",
    "suggestedPriceCents",
    "estimatedSales30d",
    "competitorCount",
    "estimatedProfitCents",
    "marginPct",
    "lastResearchedAt",
  ]);
  const direction = filters.sortDesc ? "desc" : "asc";
  const orderBy = [
    {
      [sortField]: nullableSortFields.has(sortField)
        ? { sort: direction, nulls: "last" }
        : direction,
    },
    ...(sortField === "updatedAt" ? [] : [{ updatedAt: "desc" as const }]),
  ] as Prisma.AdminArbitrageProductOrderByWithRelationInput[];

  const [databaseTotal, all, published, pending, noMatch, archived, categoryRows] =
    await Promise.all([
      db.adminArbitrageProduct.count({ where }),
      db.adminArbitrageProduct.count(),
      db.adminArbitrageProduct.count({ where: { status: "PUBLISHED" } }),
      db.adminArbitrageProduct.count({ where: { status: "PENDING" } }),
      db.adminArbitrageProduct.count({ where: { status: "NO_MATCH" } }),
      db.adminArbitrageProduct.count({ where: { status: "ARCHIVED" } }),
      db.adminArbitrageProduct.findMany({
        distinct: ["category"],
        select: { category: true },
        orderBy: { category: "asc" },
      }),
    ]);

  // User adoption is derived from seller products, rather than stored on the
  // catalog row. When it is the active sort, rank the complete filtered set
  // before slicing the requested page so pagination remains truthful.
  const inMemoryPagination =
    filters.sortKey === "usersListed" || filters.qualifiedOnly;
  let items = await db.adminArbitrageProduct.findMany({
    where,
    orderBy: filters.sortKey === "usersListed" ? { updatedAt: "desc" } : orderBy,
    ...(inMemoryPagination
      ? {}
      : {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
  });
  if (filters.qualifiedOnly) {
    items = items.filter(hasCompetitiveSuggestedPrice);
  }
  const total = filters.qualifiedOnly ? items.length : databaseTotal;
  const adoptionAsins =
    filters.sortKey === "usersListed"
      ? items.map((item) => item.asin)
      : items.map((item) => item.asin);
  const activeProducts = adoptionAsins.length
    ? await db.product.findMany({
        where: {
          sku: { in: adoptionAsins },
          listings: { some: { status: "ACTIVE" } },
        },
        select: { sku: true, userId: true },
      })
    : [];
  const userSets = new Map<string, Set<string>>();
  for (const product of activeProducts) {
    const users = userSets.get(product.sku) ?? new Set<string>();
    users.add(product.userId);
    userSets.set(product.sku, users);
  }
  if (filters.sortKey === "usersListed") {
    items.sort((a, b) => {
      const aCount = userSets.get(a.asin)?.size ?? 0;
      const bCount = userSets.get(b.asin)?.size ?? 0;
      const difference = aCount - bCount;
      if (difference !== 0) return filters.sortDesc ? -difference : difference;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    items = items.slice((page - 1) * pageSize, page * pageSize);
  } else if (filters.qualifiedOnly) {
    items = items.slice((page - 1) * pageSize, page * pageSize);
  }

  const asins = items.map((item) => item.asin);
  // Normal database-sorted pages only need adoption counts for their rows.
  const pageActiveProducts =
    filters.sortKey === "usersListed" || asins.length === 0
      ? []
      : await db.product.findMany({
          where: {
            sku: { in: asins },
            listings: { some: { status: "ACTIVE" } },
          },
          select: { sku: true, userId: true },
        });
  for (const product of pageActiveProducts) {
    const users = userSets.get(product.sku) ?? new Set<string>();
    users.add(product.userId);
    userSets.set(product.sku, users);
  }

  return {
    rows: items.map((item) => {
      const suggestedPrice = suggestedPriceFor(item);
      const margin = suggestedPrice
        ? estimateMargin(
            suggestedPrice,
            item.amazonPriceCents,
            item.amazonShippingCents,
          )
        : null;
      return {
        ...item,
        suggestedPriceCents: suggestedPrice,
        estimatedProfitCents: margin?.estimatedProfitCents ?? null,
        marginPct: margin ? Math.round(margin.marginPct) : null,
        usersListed: userSets.get(item.asin)?.size ?? 0,
        lastResearchedAt: item.lastResearchedAt?.toISOString() ?? null,
        updatedAt: item.updatedAt.toISOString(),
      };
    }),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    categories: categoryRows.map((row) => row.category),
    counts: { all, published, pending, noMatch, archived },
  };
}

/** Make a curated catalog row visible in the existing user-facing Arbitrage
 * Finder without disrupting its publishing, hiding, sorting, or export flows. */
export async function publishCatalogProductToUsers(id: string): Promise<void> {
  const item = await db.adminArbitrageProduct.findUnique({ where: { id } });
  if (
    !item ||
    !item.ebayItemId ||
    !item.ebayTitle ||
    !item.ebayPriceCents ||
    !item.ebayUrl
  ) {
    throw new Error("Research an eBay equivalent before publishing this product.");
  }
  const suggested = arbitrageSuggestedPriceCents(
    item.amazonPriceCents,
    item.ebayPriceCents,
    item.ebayRecommendedPriceCents,
    item.averageCompetitorPriceCents ?? item.ebayPriceCents,
    item.amazonShippingCents,
  );
  const margin = estimateMargin(
    suggested,
    item.amazonPriceCents,
    item.amazonShippingCents,
  );
  await db.$transaction([
    db.arbitrageItem.upsert({
      where: { ebayItemId: item.ebayItemId },
      create: {
        ebayItemId: item.ebayItemId,
        ebayTitle: item.ebayTitle,
        ebayPriceCents: item.ebayPriceCents,
        ebayUrl: item.ebayUrl,
        imageUrl: item.ebayImageUrl ?? item.amazonImageUrl ?? "",
        category: item.category,
        asin: item.asin,
        amazonTitle: item.amazonTitle,
        amazonPriceCents: item.amazonPriceCents,
        amazonShippingCents: item.amazonShippingCents,
        amazonUrl: item.amazonUrl,
        profitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        feeCents: margin.estimatedFeeCents,
        salesEst: item.estimatedSales30d ?? 0,
        competitorCount: item.competitorCount,
        avgCompPriceCents: item.averageCompetitorPriceCents,
        bestSellingPriceCents: item.ebayRecommendedPriceCents,
        matchVerdict: item.matchVerdict,
        matchConfidence: item.matchConfidence,
        matchReason: item.matchReason,
        matchMethod: "AI",
        matchCheckedAt: item.lastResearchedAt ?? new Date(),
      },
      update: {
        ebayTitle: item.ebayTitle,
        ebayPriceCents: item.ebayPriceCents,
        ebayUrl: item.ebayUrl,
        imageUrl: item.ebayImageUrl ?? item.amazonImageUrl ?? "",
        category: item.category,
        asin: item.asin,
        amazonTitle: item.amazonTitle,
        amazonPriceCents: item.amazonPriceCents,
        amazonShippingCents: item.amazonShippingCents,
        amazonUrl: item.amazonUrl,
        profitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        feeCents: margin.estimatedFeeCents,
        salesEst: item.estimatedSales30d ?? 0,
        competitorCount: item.competitorCount,
        avgCompPriceCents: item.averageCompetitorPriceCents,
        bestSellingPriceCents: item.ebayRecommendedPriceCents,
        matchVerdict: item.matchVerdict,
        matchConfidence: item.matchConfidence,
        matchReason: item.matchReason,
        matchMethod: "AI",
        matchCheckedAt: item.lastResearchedAt ?? new Date(),
      },
    }),
    db.adminArbitrageProduct.update({
      where: { id },
      data: {
        status: "PUBLISHED",
        suggestedPriceCents: suggested,
        estimatedProfitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
      },
    }),
  ]);
}

/** Keep automated/admin scans represented in the Amazon-first catalog. */
export async function syncAdminCatalogFromOpportunities(
  opportunities: ArbitrageOpportunity[],
): Promise<void> {
  const byAsin = new Map(opportunities.map((item) => [item.amazon.asin, item]));
  for (const opportunity of byAsin.values()) {
    const suggested = arbitrageSuggestedPriceCents(
      opportunity.amazon.priceCents,
      opportunity.ebay.priceCents,
      opportunity.market?.bestSellingPriceCents,
      opportunity.market?.averageCompetitorPriceCents ?? opportunity.ebay.priceCents,
      opportunity.amazon.shippingCostCents,
    );
    const margin = estimateMargin(
      suggested,
      opportunity.amazon.priceCents,
      opportunity.amazon.shippingCostCents,
    );
    const match = opportunity.match ?? {
      verdict: "MATCH",
      confidence: 100,
      reason: "The scanner supplied an already paired catalog product.",
    };
    await db.adminArbitrageProduct.upsert({
      where: { asin: opportunity.amazon.asin },
      create: {
        asin: opportunity.amazon.asin,
        amazonTitle: opportunity.amazon.title,
        amazonPriceCents: opportunity.amazon.priceCents,
        amazonShippingCents: opportunity.amazon.shippingCostCents,
        amazonUrl: opportunity.amazon.url,
        category: opportunity.category,
        isAmazonBestSeller: true,
        status: "PUBLISHED",
        ebayItemId: opportunity.ebay.itemId,
        ebayTitle: opportunity.ebay.title,
        ebayPriceCents: opportunity.ebay.priceCents,
        ebayUrl: opportunity.ebay.url,
        ebayImageUrl: opportunity.ebay.imageUrl,
        matchVerdict: match.verdict,
        matchConfidence: match.confidence,
        matchReason: match.reason,
        estimatedSales30d:
          opportunity.market?.estimatedSales30d ?? opportunity.ebay.salesLast30d,
        competitorCount: opportunity.market?.competitorCount,
        averageCompetitorPriceCents:
          opportunity.market?.averageCompetitorPriceCents,
        ebayRecommendedPriceCents:
          opportunity.market?.bestSellingPriceCents,
        suggestedPriceCents: suggested,
        estimatedProfitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        lastResearchedAt: new Date(),
      },
      update: {
        amazonTitle: opportunity.amazon.title,
        amazonPriceCents: opportunity.amazon.priceCents,
        amazonShippingCents: opportunity.amazon.shippingCostCents,
        amazonUrl: opportunity.amazon.url,
        category: opportunity.category,
        isAmazonBestSeller: true,
        status: "PUBLISHED",
        ebayItemId: opportunity.ebay.itemId,
        ebayTitle: opportunity.ebay.title,
        ebayPriceCents: opportunity.ebay.priceCents,
        ebayUrl: opportunity.ebay.url,
        ebayImageUrl: opportunity.ebay.imageUrl,
        matchVerdict: match.verdict,
        matchConfidence: match.confidence,
        matchReason: match.reason,
        estimatedSales30d:
          opportunity.market?.estimatedSales30d ?? opportunity.ebay.salesLast30d,
        competitorCount: opportunity.market?.competitorCount,
        averageCompetitorPriceCents:
          opportunity.market?.averageCompetitorPriceCents,
        ebayRecommendedPriceCents:
          opportunity.market?.bestSellingPriceCents,
        suggestedPriceCents: suggested,
        estimatedProfitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        lastResearchedAt: new Date(),
      },
    });
  }
}
