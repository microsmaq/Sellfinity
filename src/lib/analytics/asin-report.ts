import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";

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
  daily: AsinDailyPoint[];
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
        },
      },
      listings: {
        include: { orders: { orderBy: { saleDate: "asc" } } },
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
      daily: Array.from({ length: days }, (_, offset) => ({
        date: new Date(start.getTime() + offset * DAY_MS).toISOString().slice(0, 10),
        units: 0,
        revenueCents: 0,
        averageSalePriceCents: null,
      })),
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
  const completedOrders = orders.filter((order) => order.status !== "REFUNDED");
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

  const sellers: AsinSellerRow[] = await Promise.all(userIds.map(async (userId) => {
    const sellerProducts = products.filter((product) => product.userId === userId);
    const seller = sellerProducts[0].user;
    const sellerListings = listings.filter((listing) => listing.userId === userId);
    const sellerOrders = completedOrders.filter((order) => order.userId === userId);
    const prices = sellerListings.map((listing) => listing.priceCents);
    let traffic = {
      impressions: null as number | null,
      views: null as number | null,
      clickThroughRate: null as number | null,
      salesConversionRate: null as number | null,
      trafficError: null as string | null,
    };
    const ebayIds = sellerListings.flatMap((listing) => listing.ebayListingId ? [listing.ebayListingId] : []);
    if (ebayIds.length > 0 && seller.ebayConnection?.status !== "DISCONNECTED") {
      try {
        const client = await getEbayClientForUser(userId);
        if (!client.getListingTraffic) throw new Error("Traffic reporting is unavailable.");
        const rows = await client.getListingTraffic(userId, ebayIds, start, new Date());
        const impressions = rows.reduce((sum, row) => sum + (row.impressions ?? 0), 0);
        const views = rows.reduce((sum, row) => sum + (row.views ?? 0), 0);
        const rate = (key: "clickThroughRate" | "salesConversionRate") => {
          const valid = rows.filter((row) => row[key] !== null);
          return valid.length
            ? valid.reduce((sum, row) => sum + (row[key] ?? 0), 0) / valid.length
            : null;
        };
        traffic = {
          impressions,
          views,
          clickThroughRate: rate("clickThroughRate"),
          salesConversionRate: rate("salesConversionRate"),
          trafficError: null,
        };
      } catch (error) {
        traffic.trafficError = error instanceof Error && /scope|permission|access|403/i.test(error.message)
          ? "Reconnect eBay in Settings to grant read-only analytics access."
          : "eBay traffic data is temporarily unavailable.";
      }
    } else if (ebayIds.length === 0) {
      traffic.trafficError = "No published eBay listing is available for traffic reporting.";
    } else {
      traffic.trafficError = "Connect eBay to load traffic data.";
    }
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
        (sum, order) => sum + order.salePriceCents * order.quantity + order.shippingChargedCents
          - order.ebayFeeCents - order.cogsCents - order.shippingCostCents,
        0,
      ),
      currentAveragePriceCents: prices.length
        ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length)
        : null,
      ...traffic,
    };
  }));

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
    date: listing.createdAt.toISOString(),
    priceCents: listing.priceCents,
    sellerName: listing.seller.name,
    listingTitle: listing.title,
    source: "LISTING_CREATED",
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
    impressions: sellers.some((seller) => seller.impressions !== null)
      ? sellers.reduce((sum, seller) => sum + (seller.impressions ?? 0), 0)
      : null,
    views: sellers.some((seller) => seller.views !== null)
      ? sellers.reduce((sum, seller) => sum + (seller.views ?? 0), 0)
      : null,
    clickThroughRate: weightedRate(sellers, "clickThroughRate"),
    salesConversionRate: weightedRate(sellers, "salesConversionRate"),
    daily: [...dailyMap.values()],
    sellers,
    priceHistory,
  };
}
