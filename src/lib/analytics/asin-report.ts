import { db } from "@/lib/db";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { orderProfitBreakdown } from "@/lib/orders/profit";
import { loadListingTraffic, type TrafficSnapshot } from "@/lib/analytics/traffic";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";
import { assessPriceCompetitiveness, type PriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { assessProductGrowth, type ProductGrowthAssessment } from "@/lib/analytics/growth-assessment";

const DAY_MS = 86_400_000;

export type AsinDailyPoint = {
  date: string;
  units: number;
  revenueCents: number;
  averageSalePriceCents: number | null;
};

export type AsinSellerRow = {
  userId: string;
  name: string;
  email: string;
  ebayUsername: string | null;
  listingCount: number;
  activeListings: number;
  unitsSold: number;
  revenueCents: number;
  netProfitCents: number;
  currentAveragePriceCents: number | null;
  impressions: number | null;
  views: number | null;
  clickThroughRate: number | null;
  salesConversionRate: number | null;
  trafficError: string | null;
};

export type AsinPriceEvent = {
  date: string;
  priceCents: number;
  sellerName: string;
  listingTitle: string;
  source: string;
};

export type AsinTrafficDayPoint = { date: string; impressions: number; views: number };

export type AsinListingRow = {
  id: string;
  ebayListingId: string | null;
  title: string;
  status: string;
  currentPriceCents: number;
  impressions: number | null;
  views: number | null;
  clickThroughRate: number | null;
  salesConversionRate: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number | null;
  competitorCount: number | null;
  priceAssessment: PriceCompetitiveness;
};

export type AsinReport = {
  asin: string;
  title: string;
  imageUrl: string | null;
  amazonUrl: string | null;
  category: string | null;
  listingCount: number;
  activeListings: number;
  sellerCount: number;
  unitsSold: number;
  orderCount: number;
  revenueCents: number;
  netProfitCents: number;
  averageSalePriceCents: number | null;
  impressions: number | null;
  views: number | null;
  clickThroughRate: number | null;
  salesConversionRate: number | null;
  currentAverageListingPriceCents: number | null;
  averageCompetitorPriceCents: number | null;
  bestSellingPriceCents: number | null;
  suggestedPriceCents: number | null;
  competitorCount: number | null;
  priceAssessment: PriceCompetitiveness;
  growthAssessment: ProductGrowthAssessment;
  daily: AsinDailyPoint[];
  trafficDaily: AsinTrafficDayPoint[];
  listings: AsinListingRow[];
  sellers: AsinSellerRow[];
  priceHistory: AsinPriceEvent[];
};

function safeImages(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function weightedRate(rows: AsinSellerRow[], key: "clickThroughRate" | "salesConversionRate") {
  const values = rows.filter((row) => row[key] !== null);
  if (values.length === 0) return null;
  const weight = values.reduce((sum, row) => sum + Math.max(row.impressions ?? row.views ?? 1, 1), 0);
  return values.reduce(
    (sum, row) => sum + (row[key] ?? 0) * Math.max(row.impressions ?? row.views ?? 1, 1),
    0,
  ) / weight;
}

export async function getAsinReport(
  asin: string,
  options: { userId?: string; days?: number } = {},
): Promise<AsinReport | null> {
  const normalizedAsin = asin.trim().toUpperCase();
  const days = Math.min(365, Math.max(7, options.days ?? 30));
  const start = new Date(Date.now() - (days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);

  const catalog = await db.adminArbitrageProduct.findUnique({ where: { asin: normalizedAsin } });

  const products = await db.product.findMany({
    where: {
      ...(options.userId && { userId: options.userId }),
      OR: [{ sku: normalizedAsin }, { supplierProductId: normalizedAsin }],
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          ebayConnection: { select: { status: true, ebayUsername: true } },
          ebayAdRateBps: true,
          ebaySitewideDiscountBps: true,
          targetProfitEnabled: true,
          targetProfitCents: true,
        },
      },
      listings: {
        include: { orders: { include: { amazonPurchaseItem: true }, orderBy: { saleDate: "asc" } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (products.length === 0) {
    if (!catalog || options.userId) return null;
    return {
      asin: normalizedAsin,
      title: catalog.amazonTitle,
      imageUrl: catalog.amazonImageUrl,
      amazonUrl: catalog.amazonUrl,
      category: catalog.category,
      listingCount: 0,
      activeListings: 0,
      sellerCount: 0,
      unitsSold: 0,
      orderCount: 0,
      revenueCents: 0,
      netProfitCents: 0,
      averageSalePriceCents: null,
      impressions: null,
      views: null,
      clickThroughRate: null,
      salesConversionRate: null,
      currentAverageListingPriceCents: null,
      averageCompetitorPriceCents: catalog.averageCompetitorPriceCents,
      bestSellingPriceCents: catalog.ebayRecommendedPriceCents,
      suggestedPriceCents: catalog.suggestedPriceCents,
      competitorCount: catalog.competitorCount,
      priceAssessment: { label: "Not rated", tone: "slate", summary: "No seller listing price is available." },
      growthAssessment: assessProductGrowth({ activeListings: 0, impressions: null, views: null, clickThroughRate: null, salesConversionRate: null, currentPriceCents: null, averageCompetitorPriceCents: catalog.averageCompetitorPriceCents, suggestedPriceCents: catalog.suggestedPriceCents, sourceMatchConfidence: catalog.matchConfidence }),
      daily: Array.from({ length: days }, (_, offset) => ({
        date: new Date(start.getTime() + offset * DAY_MS).toISOString().slice(0, 10),
        units: 0,
        revenueCents: 0,
        averageSalePriceCents: null,
      })),
      trafficDaily: Array.from({ length: days }, (_, offset) => ({ date: new Date(start.getTime() + offset * DAY_MS).toISOString().slice(0, 10), impressions: 0, views: 0 })),
      listings: [],
      sellers: [],
      priceHistory: [],
    };
  }

  const listings = products.flatMap((product) =>
    product.listings.map((listing) => ({ ...listing, product, seller: product.user })),
  );
  const orders = listings.flatMap((listing) =>
    listing.orders.map((order) => ({ ...order, listing })),
  );
  const completedOrders = orders.filter(
    (order) => order.sourcingStatus !== "CANCELLED"
      && (order.status !== "REFUNDED" || order.ebayFinancialsSource === "ACTUAL"),
  );
  const userIds = [...new Set(products.map((product) => product.userId))];
  const listingIds = listings.map((listing) => listing.id);
  const activities = listingIds.length
    ? await db.mirrorBatchItem.findMany({
        where: {
          listingId: { in: listingIds },
          status: "SUCCEEDED",
          listingPriceCents: { not: null },
        },
        include: { batch: { select: { source: true, completedAt: true } } },
        orderBy: { completedAt: "asc" },
      })
    : [];

  const trafficByUser = new Map<string, TrafficSnapshot>();
  const sellers: AsinSellerRow[] = await Promise.all(userIds.map(async (userId) => {
    const sellerProducts = products.filter((product) => product.userId === userId);
    const seller = sellerProducts[0].user;
    const sellerListings = listings.filter((listing) => listing.userId === userId);
    const sellerOrders = completedOrders.filter((order) => order.userId === userId);
    const prices = sellerListings.map((listing) => listing.priceCents);
    const ebayIds = sellerListings.flatMap((listing) => listing.ebayListingId ? [listing.ebayListingId] : []);
    const snapshot = await loadListingTraffic({ userId, ebayListingIds: ebayIds, start, end: new Date(), connected: Boolean(seller.ebayConnection && seller.ebayConnection.status !== "DISCONNECTED") });
    trafficByUser.set(userId, snapshot);
    const impressions = snapshot.rows.length ? snapshot.rows.reduce((sum, row) => sum + (row.impressions ?? 0), 0) : null;
    const views = snapshot.rows.length ? snapshot.rows.reduce((sum, row) => sum + (row.views ?? 0), 0) : null;
    const conversionRows = snapshot.rows.filter((row) => row.salesConversionRate !== null);
    return {
      userId,
      name: seller.name,
      email: seller.email,
      ebayUsername: seller.ebayConnection?.ebayUsername ?? null,
      listingCount: sellerListings.length,
      activeListings: sellerListings.filter((listing) => listing.status === "ACTIVE").length,
      unitsSold: sellerOrders.reduce((sum, order) => sum + order.quantity, 0),
      revenueCents: sellerOrders.reduce(
        (sum, order) => sum + order.salePriceCents * order.quantity + order.shippingChargedCents,
        0,
      ),
      netProfitCents: sellerOrders.reduce(
        (sum, order) => {
          const breakdown = orderProfitBreakdown({
            ...order,
            actualAmazonCostCents: order.amazonPurchaseItem ? actualAmazonCost(order.amazonPurchaseItem) : null,
          }, seller.ebayAdRateBps);
          return sum + breakdown.profitCents;
        },
        0,
      ),
      currentAveragePriceCents: prices.length
        ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length)
        : null,
      impressions,
      views,
      clickThroughRate: impressions ? ((views ?? 0) / impressions) * 100 : null,
      salesConversionRate: conversionRows.length ? conversionRows.reduce((sum, row) => sum + (row.salesConversionRate ?? 0) * Math.max(row.views ?? 1, 1), 0) / conversionRows.reduce((sum, row) => sum + Math.max(row.views ?? 1, 1), 0) : null,
      trafficError: snapshot.error,
    };
  }));

  const marketMetrics = listings.some((listing) => listing.ebayListingId)
    ? await db.ebayMarketMetric.findMany({
        where: {
          ebayListingId: { in: listings.flatMap((listing) => listing.ebayListingId ? [listing.ebayListingId] : []) },
          userId: { in: userIds },
        },
      })
    : [];
  const marketByListing = new Map(marketMetrics.map((metric) => [`${metric.userId}:${metric.ebayListingId}`, metric]));
  const listingRows: AsinListingRow[] = listings.map((listing) => {
    const metric = trafficByUser.get(listing.userId)?.rows.find((row) => row.ebayListingId === listing.ebayListingId);
    const market = listing.ebayListingId ? marketByListing.get(`${listing.userId}:${listing.ebayListingId}`) : null;
    const suggestedPriceCents = market ? arbitrageSuggestedPriceCents(
      listing.product.costCents,
      listing.priceCents,
      market.bestSellingPriceCents,
      market.averageCompetitorPriceCents,
      listing.product.shippingCostCents,
      listing.seller.ebaySitewideDiscountBps,
      listing.seller.ebayAdRateBps,
      listing.seller.targetProfitEnabled ? listing.seller.targetProfitCents : null,
    ) : listing.product.suggestedPriceCents || catalog?.suggestedPriceCents || null;
    const averageCompetitorPriceCents = market?.averageCompetitorPriceCents ?? catalog?.averageCompetitorPriceCents ?? null;
    return {
      id: listing.id,
      ebayListingId: listing.ebayListingId,
      title: listing.title,
      status: listing.status,
      currentPriceCents: listing.priceCents,
      impressions: metric?.impressions ?? null,
      views: metric?.views ?? null,
      clickThroughRate: metric?.clickThroughRate ?? null,
      salesConversionRate: metric?.salesConversionRate ?? null,
      averageCompetitorPriceCents,
      suggestedPriceCents,
      competitorCount: market?.competitorCount ?? catalog?.competitorCount ?? null,
      priceAssessment: assessPriceCompetitiveness(
        listing.priceCents,
        catalog?.ebayPriceCents ?? averageCompetitorPriceCents ?? listing.priceCents,
        averageCompetitorPriceCents,
        market?.bestSellingPriceCents ?? catalog?.ebayRecommendedPriceCents,
        suggestedPriceCents,
        listing.seller.ebaySitewideDiscountBps,
      ),
    };
  });

  const trafficDailyMap = new Map<string, AsinTrafficDayPoint>();
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(start.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
    trafficDailyMap.set(date, { date, impressions: 0, views: 0 });
  }
  for (const snapshot of trafficByUser.values()) {
    for (const point of snapshot.daily) {
      const aggregate = trafficDailyMap.get(point.date);
      if (!aggregate) continue;
      aggregate.impressions += point.impressions;
      aggregate.views += point.views;
    }
  }

  const dailyMap = new Map<string, AsinDailyPoint>();
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(start.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
    dailyMap.set(date, { date, units: 0, revenueCents: 0, averageSalePriceCents: null });
  }
  const dailyPrices = new Map<string, number[]>();
  for (const order of completedOrders) {
    const date = order.saleDate.toISOString().slice(0, 10);
    const point = dailyMap.get(date);
    if (!point) continue;
    point.units += order.quantity;
    point.revenueCents += order.salePriceCents * order.quantity + order.shippingChargedCents;
    dailyPrices.set(date, [...(dailyPrices.get(date) ?? []), order.salePriceCents]);
  }
  for (const [date, prices] of dailyPrices) {
    dailyMap.get(date)!.averageSalePriceCents = Math.round(
      prices.reduce((sum, price) => sum + price, 0) / prices.length,
    );
  }

  const initialPrices: AsinPriceEvent[] = listings.map((listing) => ({
    date: listing.updatedAt.toISOString(),
    priceCents: listing.priceCents,
    sellerName: listing.seller.name,
    listingTitle: listing.title,
    source: "CURRENT_SNAPSHOT",
  }));
  const priceHistory: AsinPriceEvent[] = [...initialPrices, ...activities.map((activity) => {
    const listing = listings.find((row) => row.id === activity.listingId)!;
    return {
      date: (activity.completedAt ?? activity.batch.completedAt ?? activity.createdAt).toISOString(),
      priceCents: activity.listingPriceCents!,
      sellerName: listing?.seller.name ?? "Seller",
      listingTitle: activity.title ?? listing?.title ?? normalizedAsin,
      source: activity.batch.source,
    };
  })].sort((left, right) => left.date.localeCompare(right.date));

  const totalRevenue = sellers.reduce((sum, seller) => sum + seller.revenueCents, 0);
  const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const currentAverageListingPriceCents = average(listingRows.map((listing) => listing.currentPriceCents));
  const averageCompetitorPriceCents = average(listingRows.flatMap((listing) => listing.averageCompetitorPriceCents ? [listing.averageCompetitorPriceCents] : [])) ?? catalog?.averageCompetitorPriceCents ?? null;
  const bestSellingPriceCents = average(marketMetrics.flatMap((metric) => metric.bestSellingPriceCents ? [metric.bestSellingPriceCents] : [])) ?? catalog?.ebayRecommendedPriceCents ?? null;
  const suggestedPriceCents = average(listingRows.flatMap((listing) => listing.suggestedPriceCents ? [listing.suggestedPriceCents] : [])) ?? catalog?.suggestedPriceCents ?? null;
  const competitorCount = marketMetrics.length ? Math.max(...marketMetrics.map((metric) => metric.competitorCount)) : catalog?.competitorCount ?? null;
  const aggregatePriceAssessment = currentAverageListingPriceCents === null
    ? { label: "Not rated", tone: "slate", summary: "No seller listing price is available." } as PriceCompetitiveness
    : assessPriceCompetitiveness(currentAverageListingPriceCents, catalog?.ebayPriceCents ?? averageCompetitorPriceCents ?? currentAverageListingPriceCents, averageCompetitorPriceCents, bestSellingPriceCents, suggestedPriceCents);
  const aggregateImpressions = sellers.some((seller) => seller.impressions !== null) ? sellers.reduce((sum, seller) => sum + (seller.impressions ?? 0), 0) : null;
  const aggregateViews = sellers.some((seller) => seller.views !== null) ? sellers.reduce((sum, seller) => sum + (seller.views ?? 0), 0) : null;
  const aggregateCtr = aggregateImpressions ? ((aggregateViews ?? 0) / aggregateImpressions) * 100 : null;
  const aggregateConversion = weightedRate(sellers, "salesConversionRate");
  const first = products[0];
  return {
    asin: normalizedAsin,
    title: catalog?.amazonTitle ?? first.title,
    imageUrl: catalog?.amazonImageUrl ?? safeImages(first.imageUrlsJson)[0] ?? null,
    amazonUrl: catalog?.amazonUrl ?? first.supplierUrl,
    category: catalog?.category ?? first.category,
    listingCount: listings.length,
    activeListings: listings.filter((listing) => listing.status === "ACTIVE").length,
    sellerCount: sellers.length,
    unitsSold: sellers.reduce((sum, seller) => sum + seller.unitsSold, 0),
    orderCount: completedOrders.length,
    revenueCents: totalRevenue,
    netProfitCents: sellers.reduce((sum, seller) => sum + seller.netProfitCents, 0),
    averageSalePriceCents: completedOrders.length
      ? Math.round(totalRevenue / completedOrders.reduce((sum, order) => sum + order.quantity, 0))
      : null,
    impressions: aggregateImpressions,
    views: aggregateViews,
    clickThroughRate: aggregateCtr,
    salesConversionRate: aggregateConversion,
    currentAverageListingPriceCents,
    averageCompetitorPriceCents,
    bestSellingPriceCents,
    suggestedPriceCents,
    competitorCount,
    priceAssessment: aggregatePriceAssessment,
    growthAssessment: assessProductGrowth({
      activeListings: listings.filter((listing) => listing.status === "ACTIVE").length,
      impressions: aggregateImpressions,
      views: aggregateViews,
      clickThroughRate: aggregateCtr,
      salesConversionRate: aggregateConversion,
      currentPriceCents: currentAverageListingPriceCents,
      averageCompetitorPriceCents,
      suggestedPriceCents,
      sourceMatchConfidence: average(listings.flatMap((listing) => listing.sourceMatchConfidence !== null ? [listing.sourceMatchConfidence] : [])),
    }),
    daily: [...dailyMap.values()],
    trafficDaily: [...trafficDailyMap.values()],
    listings: listingRows,
    sellers,
    priceHistory,
  };
}
