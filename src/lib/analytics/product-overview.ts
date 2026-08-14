import "server-only";
import { db } from "@/lib/db";
import { parseImageUrls } from "@/lib/types";

const DAY_MS = 86_400_000;

export type ProductAnalyticsRow = {
  asin: string;
  title: string;
  imageUrl: string | null;
  category: string | null;
  sellerCount: number;
  listingCount: number;
  activeListings: number;
  orderCount: number;
  unitsSold: number;
  revenueCents: number;
  netProfitCents: number;
  averageListingPriceCents: number | null;
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
  totals: {
    productCount: number;
    mirroredProductCount: number;
    sellerCount: number;
    listingCount: number;
    activeListings: number;
    unitsSold: number;
    revenueCents: number;
    netProfitCents: number;
  };
};

function normalizeAsin(product: { supplierProductId: string; sku: string }): string {
  return (product.supplierProductId || product.sku).trim().toUpperCase();
}

export async function getProductAnalyticsOverview(options: {
  userId?: string;
  includeCatalog?: boolean;
  days?: number;
} = {}): Promise<ProductAnalyticsOverview> {
  const days = Math.min(90, Math.max(7, options.days ?? 30));
  const start = new Date(Date.now() - (days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);

  const [products, catalog] = await Promise.all([
    db.product.findMany({
      where: options.userId ? { userId: options.userId } : undefined,
      include: { listings: { include: { orders: true } } },
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
  const rowsByAsin = new Map<string, ProductAnalyticsRow & { sellerIds: Set<string>; prices: number[] }>();

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
      orderCount: 0,
      unitsSold: 0,
      revenueCents: 0,
      netProfitCents: 0,
      averageListingPriceCents: null,
      prices: [],
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
      orderCount: 0,
      unitsSold: 0,
      revenueCents: 0,
      netProfitCents: 0,
      averageListingPriceCents: null,
      prices: [] as number[],
      createdAt: product.createdAt.toISOString(),
      lastActivityAt: product.createdAt.toISOString(),
    };
    row.sellerIds.add(product.userId);
    row.listingCount += product.listings.length;
    row.activeListings += product.listings.filter((listing) => listing.status === "ACTIVE").length;
    row.prices.push(...product.listings.map((listing) => listing.priceCents));
    if (product.createdAt.toISOString() < row.createdAt) row.createdAt = product.createdAt.toISOString();

    for (const listing of product.listings) {
      if (listing.updatedAt.toISOString() > row.lastActivityAt) row.lastActivityAt = listing.updatedAt.toISOString();
      for (const order of listing.orders) {
        if (order.status === "REFUNDED") continue;
        const revenue = order.salePriceCents * order.quantity + order.shippingChargedCents;
        const profit = revenue - order.ebayFeeCents - order.cogsCents - order.shippingCostCents;
        row.orderCount += 1;
        row.unitsSold += order.quantity;
        row.revenueCents += revenue;
        row.netProfitCents += profit;
        if (order.saleDate.toISOString() > row.lastActivityAt) row.lastActivityAt = order.saleDate.toISOString();
        const point = dailyByDate.get(order.saleDate.toISOString().slice(0, 10));
        if (point) {
          point.units += order.quantity;
          point.revenueCents += revenue;
          point.netProfitCents += profit;
        }
      }
    }
    rowsByAsin.set(asin, row);
  }

  const rows = [...rowsByAsin.values()].map(({ sellerIds, prices, ...row }) => ({
    ...row,
    sellerCount: sellerIds.size,
    averageListingPriceCents: prices.length
      ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length)
      : null,
  }));
  const sellerIds = new Set(products.map((product) => product.userId));

  return {
    rows,
    daily,
    totals: {
      productCount: rows.length,
      mirroredProductCount: rows.filter((row) => row.sellerCount > 0).length,
      sellerCount: sellerIds.size,
      listingCount: rows.reduce((sum, row) => sum + row.listingCount, 0),
      activeListings: rows.reduce((sum, row) => sum + row.activeListings, 0),
      unitsSold: rows.reduce((sum, row) => sum + row.unitsSold, 0),
      revenueCents: rows.reduce((sum, row) => sum + row.revenueCents, 0),
      netProfitCents: rows.reduce((sum, row) => sum + row.netProfitCents, 0),
    },
  };
}
