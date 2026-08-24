import "server-only";
import { db } from "@/lib/db";
import { parseImageUrls } from "@/lib/types";
import { DEFAULT_EBAY_AD_RATE_BPS } from "@/lib/fees";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { orderProfitBreakdown } from "@/lib/orders/profit";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";
import { assessPriceCompetitiveness, type PriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { loadListingTraffic } from "@/lib/analytics/traffic";
import { assessVerifiedWinner } from "@/lib/listings/winner-policy";

const DAY_MS = 86_400_000;

export type ProductAnalyticsRow = {
  asin: string;
  title: string;
  imageUrl: string | null;
  category: string | null;
  sellerCount: number;
  listingCount: number;
  activeListings: number;
  verifiedWinner: boolean;
  orderCount: number;
  unitsSold: number;
  revenueCents: number;
  netProfitCents: number;
  averageListingPriceCents: number | null;
  impressions: number | null;
  views: number | null;
  clickThroughRate: number | null;
  salesConversionRate: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number | null;
  competitorCount: number | null;
  priceAssessment: PriceCompetitiveness;
  createdAt: string;
  lastActivityAt: string;
};

export type ProductAnalyticsDay = {
  date: string;
  units: number;
  revenueCents: number;
  netProfitCents: number;
};

export type ProductAnalyticsOverview = {
  rows: ProductAnalyticsRow[];
  daily: ProductAnalyticsDay[];
  trafficDaily: { date: string; impressions: number; views: number }[];
  trafficError: string | null;
  totals: {
    productCount: number;
    mirroredProductCount: number;
    sellerCount: number;
    listingCount: number;
    activeListings: number;
    unitsSold: number;
    revenueCents: number;
    netProfitCents: number;
    impressions: number | null;
    views: number | null;
    clickThroughRate: number | null;
    salesConversionRate: number | null;
  };
};

function normalizeAsin(product: { supplierProductId: string; sku: string }): string {
  return (product.supplierProductId || product.sku).trim().toUpperCase();
}

export async function getProductAnalyticsOverview(options: {
  userId?: string;
  includeCatalog?: boolean;
  days?: number;
  startDate?: Date;
  endDate?: Date;
} = {}): Promise<ProductAnalyticsOverview> {
  const end = new Date(options.endDate ?? Date.now());
  end.setUTCHours(23, 59, 59, 999);
  const fallbackDays = Math.min(90, Math.max(7, options.days ?? 30));
  const requestedStart = options.startDate
    ? new Date(options.startDate)
    : new Date(end.getTime() - (fallbackDays - 1) * DAY_MS);
  const earliestAllowed = new Date(end.getTime() - 89 * DAY_MS);
  const start = requestedStart < earliestAllowed ? earliestAllowed : requestedStart;
  start.setUTCHours(0, 0, 0, 0);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);

  const [products, catalog] = await Promise.all([
    db.product.findMany({
      where: options.userId ? { userId: options.userId } : undefined,
      include: {
        user: { select: { ebayAdRateBps: true, ebaySitewideDiscountBps: true, targetProfitEnabled: true, targetProfitCents: true, ebayConnection: { select: { status: true } } } },
        listings: { include: { orders: { include: { amazonPurchaseItem: true } } } },
      },
      orderBy: { createdAt: "desc" },
    }),
    options.includeCatalog
      ? db.adminArbitrageProduct.findMany({ orderBy: { createdAt: "desc" } })
      : Promise.resolve([]),
  ]);

  const daily = Array.from({ length: days }, (_, offset) => ({
    date: new Date(start.getTime() + offset * DAY_MS).toISOString().slice(0, 10),
    units: 0,
    revenueCents: 0,
    netProfitCents: 0,
  }));
  const dailyByDate = new Map(daily.map((point) => [point.date, point]));
  const rowsByAsin = new Map<string, Omit<ProductAnalyticsRow, "priceAssessment"> & {
    sellerIds: Set<string>;
    prices: number[];
    ebayListingIds: string[];
    suggestedPrices: number[];
    competitorPrices: number[];
    competitorCounts: number[];
    catalogEbayPriceCents: number | null;
  }>();

  for (const item of catalog) {
    const asin = item.asin.trim().toUpperCase();
    rowsByAsin.set(asin, {
      asin,
      title: item.amazonTitle,
      imageUrl: item.amazonImageUrl,
      category: item.category,
      sellerCount: 0,
      sellerIds: new Set(),
      listingCount: 0,
      activeListings: 0,
      verifiedWinner: false,
      orderCount: 0,
      unitsSold: 0,
      revenueCents: 0,
      netProfitCents: 0,
      averageListingPriceCents: null,
      impressions: null,
      views: null,
      clickThroughRate: null,
      salesConversionRate: null,
      averageCompetitorPriceCents: item.averageCompetitorPriceCents,
      suggestedPriceCents: item.suggestedPriceCents,
      competitorCount: item.competitorCount,
      prices: [],
      ebayListingIds: [], suggestedPrices: item.suggestedPriceCents ? [item.suggestedPriceCents] : [],
      competitorPrices: item.averageCompetitorPriceCents ? [item.averageCompetitorPriceCents] : [],
      competitorCounts: item.competitorCount ? [item.competitorCount] : [],
      catalogEbayPriceCents: item.ebayPriceCents,
      createdAt: item.createdAt.toISOString(),
      lastActivityAt: item.updatedAt.toISOString(),
    });
  }

  for (const product of products) {
    const asin = normalizeAsin(product);
    if (!asin) continue;
    const existing = rowsByAsin.get(asin);
    const row = existing ?? {
      asin,
      title: product.title,
      imageUrl: parseImageUrls(product.imageUrlsJson)[0] ?? null,
      category: product.category,
      sellerCount: 0,
      sellerIds: new Set<string>(),
      listingCount: 0,
      activeListings: 0,
      verifiedWinner: false,
      orderCount: 0,
      unitsSold: 0,
      revenueCents: 0,
      netProfitCents: 0,
      averageListingPriceCents: null,
      impressions: null, views: null, clickThroughRate: null, salesConversionRate: null,
      averageCompetitorPriceCents: null, suggestedPriceCents: null, competitorCount: null,
      prices: [] as number[],
      ebayListingIds: [] as string[], suggestedPrices: [] as number[], competitorPrices: [] as number[],
      competitorCounts: [] as number[], catalogEbayPriceCents: null,
      createdAt: product.createdAt.toISOString(),
      lastActivityAt: product.createdAt.toISOString(),
    };
    row.sellerIds.add(product.userId);
    row.listingCount += product.listings.length;
    row.activeListings += product.listings.filter((listing) => listing.status === "ACTIVE").length;
    row.prices.push(...product.listings.map((listing) => listing.priceCents));
    row.ebayListingIds.push(...product.listings.flatMap((listing) => listing.ebayListingId ? [listing.ebayListingId] : []));
    if (product.createdAt.toISOString() < row.createdAt) row.createdAt = product.createdAt.toISOString();

    for (const listing of product.listings) {
      if (listing.updatedAt.toISOString() > row.lastActivityAt) row.lastActivityAt = listing.updatedAt.toISOString();
      const winnerOrders: { saleDate: Date; quantity: number; profitCents: number }[] = [];
      for (const order of listing.orders) {
        if (order.sourcingStatus === "CANCELLED" || (order.status === "REFUNDED" && order.ebayFinancialsSource !== "ACTUAL")) continue;
        const breakdown = orderProfitBreakdown({
          ...order,
          actualAmazonCostCents: order.amazonPurchaseItem ? actualAmazonCost(order.amazonPurchaseItem) : null,
        },
          product.user.ebayAdRateBps ?? DEFAULT_EBAY_AD_RATE_BPS,
        );
        if (order.status !== "REFUNDED") winnerOrders.push({ saleDate: order.saleDate, quantity: order.quantity, profitCents: breakdown.profitCents });
        if (order.saleDate < start || order.saleDate > end) continue;
        row.orderCount += 1;
        row.unitsSold += order.quantity;
        row.revenueCents += breakdown.revenueCents;
        row.netProfitCents += breakdown.profitCents;
        if (order.saleDate.toISOString() > row.lastActivityAt) row.lastActivityAt = order.saleDate.toISOString();
        const point = dailyByDate.get(order.saleDate.toISOString().slice(0, 10));
        if (point) {
          point.units += order.quantity;
          point.revenueCents += breakdown.revenueCents;
          point.netProfitCents += breakdown.profitCents;
        }
      }
      if (assessVerifiedWinner(winnerOrders).isWinner) row.verifiedWinner = true;
    }
    rowsByAsin.set(asin, row);
  }

  const publishedListings = products.flatMap((product) => product.listings.flatMap((listing) =>
    listing.ebayListingId ? [{ listing, product }] : [],
  ));
  const marketMetrics = publishedListings.length ? await db.ebayMarketMetric.findMany({
    where: {
      ...(options.userId && { userId: options.userId }),
      ebayListingId: { in: publishedListings.map(({ listing }) => listing.ebayListingId!) },
    },
  }) : [];
  const marketByListing = new Map(marketMetrics.map((metric) => [`${metric.userId}:${metric.ebayListingId}`, metric]));
  for (const { listing, product } of publishedListings) {
    const row = rowsByAsin.get(normalizeAsin(product));
    const market = marketByListing.get(`${product.userId}:${listing.ebayListingId}`);
    if (!row || !market) continue;
    row.competitorPrices.push(market.averageCompetitorPriceCents);
    row.competitorCounts.push(market.competitorCount);
    row.suggestedPrices.push(arbitrageSuggestedPriceCents(
      product.costCents, listing.priceCents, market.bestSellingPriceCents,
      market.averageCompetitorPriceCents, product.shippingCostCents,
      product.user.ebaySitewideDiscountBps, product.user.ebayAdRateBps,
      product.user.targetProfitEnabled ? product.user.targetProfitCents : null,
    ));
  }

  let trafficError: string | null = null;
  let trafficDaily = daily.map((point) => ({ date: point.date, impressions: 0, views: 0 }));
  if (options.userId) {
    const connection = products[0]?.user.ebayConnection;
    const traffic = await loadListingTraffic({
      userId: options.userId,
      ebayListingIds: publishedListings.map(({ listing }) => listing.ebayListingId!),
      start, end, connected: Boolean(connection && connection.status !== "DISCONNECTED"),
      trendScope: "ACCOUNT",
    });
    trafficError = traffic.error;
    const trafficById = new Map(traffic.rows.map((metric) => [metric.ebayListingId, metric]));
    for (const row of rowsByAsin.values()) {
      const metrics = row.ebayListingIds.flatMap((id) => trafficById.get(id) ? [trafficById.get(id)!] : []);
      if (!metrics.length) continue;
      row.impressions = metrics.reduce((sum, metric) => sum + (metric.impressions ?? 0), 0);
      row.views = metrics.reduce((sum, metric) => sum + (metric.views ?? 0), 0);
      row.clickThroughRate = row.impressions ? (row.views / row.impressions) * 100 : null;
      const conversions = metrics.filter((metric) => metric.salesConversionRate !== null);
      row.salesConversionRate = conversions.length
        ? conversions.reduce((sum, metric) => sum + (metric.salesConversionRate ?? 0) * Math.max(metric.views ?? 1, 1), 0) /
          conversions.reduce((sum, metric) => sum + Math.max(metric.views ?? 1, 1), 0)
        : null;
    }
    const dailyTraffic = new Map(traffic.daily.map((point) => [point.date, point]));
    trafficDaily = trafficDaily.map((point) => ({ ...point, ...(dailyTraffic.get(point.date) ?? {}) }));
  }

  const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  // The listing IDs are used for joining traffic above and intentionally omitted from the public row.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const rows = [...rowsByAsin.values()].map(({ sellerIds, prices, ebayListingIds, suggestedPrices, competitorPrices, competitorCounts, catalogEbayPriceCents, ...row }) => {
    const averageListingPriceCents = average(prices);
    const averageCompetitorPriceCents = average(competitorPrices) ?? row.averageCompetitorPriceCents;
    const suggestedPriceCents = average(suggestedPrices) ?? row.suggestedPriceCents;
    return {
      ...row,
      sellerCount: sellerIds.size,
      averageListingPriceCents,
      averageCompetitorPriceCents,
      suggestedPriceCents,
      competitorCount: competitorCounts.length ? Math.max(...competitorCounts) : row.competitorCount,
      priceAssessment: averageListingPriceCents === null
        ? { label: "Not rated", tone: "slate", summary: "No active listing price is available." } as PriceCompetitiveness
        : assessPriceCompetitiveness(averageListingPriceCents, catalogEbayPriceCents ?? averageCompetitorPriceCents ?? averageListingPriceCents, averageCompetitorPriceCents, null, suggestedPriceCents),
    };
  });
  const sellerIds = new Set(products.map((product) => product.userId));

  return {
    rows,
    daily,
    trafficDaily,
    trafficError,
    totals: {
      productCount: rows.length,
      mirroredProductCount: rows.filter((row) => row.sellerCount > 0).length,
      sellerCount: sellerIds.size,
      listingCount: rows.reduce((sum, row) => sum + row.listingCount, 0),
      activeListings: rows.reduce((sum, row) => sum + row.activeListings, 0),
      unitsSold: rows.reduce((sum, row) => sum + row.unitsSold, 0),
      revenueCents: rows.reduce((sum, row) => sum + row.revenueCents, 0),
      netProfitCents: rows.reduce((sum, row) => sum + row.netProfitCents, 0),
      impressions: rows.some((row) => row.impressions !== null) ? rows.reduce((sum, row) => sum + (row.impressions ?? 0), 0) : null,
      views: rows.some((row) => row.views !== null) ? rows.reduce((sum, row) => sum + (row.views ?? 0), 0) : null,
      clickThroughRate: (() => {
        const impressions = rows.reduce((sum, row) => sum + (row.impressions ?? 0), 0);
        return impressions ? rows.reduce((sum, row) => sum + (row.views ?? 0), 0) / impressions * 100 : null;
      })(),
      salesConversionRate: (() => {
        const rated = rows.filter((row) => row.salesConversionRate !== null);
        const weight = rated.reduce((sum, row) => sum + Math.max(row.views ?? 1, 1), 0);
        return weight ? rated.reduce((sum, row) => sum + (row.salesConversionRate ?? 0) * Math.max(row.views ?? 1, 1), 0) / weight : null;
      })(),
    },
  };
}
