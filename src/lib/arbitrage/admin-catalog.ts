import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import { suggestedListingPriceCents } from "@/lib/listings/cleanup";
import type { ArbitrageOpportunity } from "./scanner";

export const ADMIN_CATALOG_PAGE_SIZE = 50;

export type AdminCatalogStatus =
  | "ALL"
  | "PENDING"
  | "PUBLISHED"
  | "NO_MATCH"
  | "ARCHIVED";

export type AdminCatalogRow = {
  id: string;
  asin: string;
  amazonTitle: string;
  amazonPriceCents: number;
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
  counts: Record<"all" | "published" | "pending" | "noMatch" | "archived", number>;
};

export async function listAdminCatalog(params: {
  page: number;
  query?: string;
  status?: AdminCatalogStatus;
}): Promise<AdminCatalogPage> {
  const page = Math.max(1, params.page);
  const query = params.query?.trim() ?? "";
  const status = params.status ?? "ALL";
  const where: Prisma.AdminArbitrageProductWhereInput = {
    ...(status !== "ALL" && { status }),
    ...(query && {
      OR: [
        { asin: { contains: query, mode: "insensitive" } },
        { amazonTitle: { contains: query, mode: "insensitive" } },
        { ebayTitle: { contains: query, mode: "insensitive" } },
      ],
    }),
  };

  const [total, items, all, published, pending, noMatch, archived] =
    await Promise.all([
      db.adminArbitrageProduct.count({ where }),
      db.adminArbitrageProduct.findMany({
        where,
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        skip: (page - 1) * ADMIN_CATALOG_PAGE_SIZE,
        take: ADMIN_CATALOG_PAGE_SIZE,
      }),
      db.adminArbitrageProduct.count(),
      db.adminArbitrageProduct.count({ where: { status: "PUBLISHED" } }),
      db.adminArbitrageProduct.count({ where: { status: "PENDING" } }),
      db.adminArbitrageProduct.count({ where: { status: "NO_MATCH" } }),
      db.adminArbitrageProduct.count({ where: { status: "ARCHIVED" } }),
    ]);

  const asins = items.map((item) => item.asin);
  const activeProducts = asins.length
    ? await db.product.findMany({
        where: {
          sku: { in: asins },
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

  return {
    rows: items.map((item) => ({
      ...item,
      usersListed: userSets.get(item.asin)?.size ?? 0,
      lastResearchedAt: item.lastResearchedAt?.toISOString() ?? null,
      updatedAt: item.updatedAt.toISOString(),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_CATALOG_PAGE_SIZE)),
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
  const suggested = item.suggestedPriceCents ??
    suggestedListingPriceCents(
      item.amazonPriceCents,
      0,
      item.averageCompetitorPriceCents ?? item.ebayPriceCents,
    );
  const margin = estimateMargin(suggested, item.amazonPriceCents, 0);
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
    const suggested = suggestedListingPriceCents(
      opportunity.amazon.priceCents,
      0,
      opportunity.market?.averageCompetitorPriceCents ?? opportunity.ebay.priceCents,
    );
    const margin = estimateMargin(suggested, opportunity.amazon.priceCents, 0);
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
