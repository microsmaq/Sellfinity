import "server-only";

import { db } from "@/lib/db";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { orderProfitBreakdown } from "@/lib/orders/profit";
import { summarize, windowStartUtc, type DayPoint } from "@/lib/orders/stats";

type LoadedOrder = Awaited<ReturnType<typeof loadSellerRows>>[number]["orders"][number];
type LoadedSeller = Awaited<ReturnType<typeof loadSellerRows>>[number];

function loadSellerRows(cutoff: Date) {
  return db.user.findMany({
    where: { role: "USER" },
    orderBy: { createdAt: "desc" },
    include: {
      ebayConnection: { select: { status: true, ebayUsername: true, connectedAt: true } },
      amazonEmailConnection: { select: { status: true, email: true, lastSyncedAt: true, lastSyncError: true } },
      listings: { select: { id: true, status: true, updatedAt: true } },
      syncIssues: { where: { resolution: "OPEN" }, select: { id: true } },
      syncRuns: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } },
      orders: {
        where: { saleDate: { gte: cutoff } },
        orderBy: { saleDate: "desc" },
        include: {
          amazonPurchaseItem: true,
          listing: { select: { product: { select: { id: true, sku: true, title: true } } } },
        },
      },
    },
  });
}

function withActualAmazonCost(order: LoadedOrder) {
  return {
    ...order,
    actualAmazonCostCents: order.amazonPurchaseItem
      ? actualAmazonCost(order.amazonPurchaseItem)
      : null,
  };
}

export type AdminSellerRow = {
  id: string;
  name: string;
  email: string;
  plan: string;
  createdAt: Date;
  ebayStatus: string;
  ebayUsername: string | null;
  amazonStatus: string;
  activeListings: number;
  totalListings: number;
  orders: number;
  units: number;
  revenueCents: number;
  netCents: number;
  marginPct: number;
  actualFinancialOrders: number;
  verifiedCostOrders: number;
  unprofitableOrders: number;
  openIssues: number;
  latestStoreActivity: Date | null;
};

function sellerRow(user: LoadedSeller): AdminSellerRow {
    const orders = user.orders.map(withActualAmazonCost);
    const totals = summarize(orders, user.ebayAdRateBps);
    const includedOrders = orders.filter((order) =>
      order.sourcingStatus !== "CANCELLED"
      && !(order.status === "REFUNDED" && order.ebayFinancialsSource !== "ACTUAL"),
    );
    const unprofitableOrders = includedOrders.filter(
      (order) => orderProfitBreakdown(order, user.ebayAdRateBps).profitCents < 0,
    ).length;
    const latestListing = user.listings.reduce<Date | null>(
      (latest, listing) => !latest || listing.updatedAt > latest ? listing.updatedAt : latest,
      null,
    );
    const latestOrder = user.orders[0]?.saleDate ?? null;
    const latestSync = user.syncRuns[0]?.startedAt ?? null;
    const latestStoreActivity = [latestListing, latestOrder, latestSync]
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      createdAt: user.createdAt,
      ebayStatus: user.ebayConnection?.status ?? "DISCONNECTED",
      ebayUsername: user.ebayConnection?.ebayUsername ?? null,
      amazonStatus: user.amazonEmailConnection?.status ?? "DISCONNECTED",
      activeListings: user.listings.filter((listing) => listing.status === "ACTIVE").length,
      totalListings: user.listings.length,
      orders: totals.orders,
      units: totals.units,
      revenueCents: totals.revenueCents,
      netCents: totals.netCents,
      marginPct: totals.revenueCents > 0 ? (totals.netCents / totals.revenueCents) * 100 : 0,
      actualFinancialOrders: includedOrders.filter((order) => order.ebayFinancialsSource === "ACTUAL").length,
      verifiedCostOrders: includedOrders.filter((order) => order.actualAmazonCostCents !== null).length,
      unprofitableOrders,
      openIssues: user.syncIssues.length,
      latestStoreActivity,
    };
}

export async function getAdminSellerRows(days = 30): Promise<AdminSellerRow[]> {
  const cutoff = windowStartUtc(days);
  const users = await loadSellerRows(cutoff);
  return users.map(sellerRow);
}

export async function getAdminPlatformOverview(days = 30) {
  const cutoff = windowStartUtc(days);
  const [sellers, users, catalog, dataHealth] = await Promise.all([
    loadSellerRows(cutoff),
    db.user.count({ where: { role: "USER" } }),
    Promise.all([
      db.adminArbitrageProduct.count(),
      db.adminArbitrageProduct.count({ where: { status: "PUBLISHED" } }),
      db.adminArbitrageProduct.count({ where: { status: { in: ["PENDING", "NO_MATCH"] } } }),
    ]),
    Promise.all([
      db.syncIssue.count({ where: { resolution: "OPEN" } }),
      db.order.count({ where: { ebayTrackingSyncError: { not: null } } }),
      db.order.count({ where: { saleDate: { gte: cutoff }, ebayFinancialsSource: "ESTIMATED" } }),
      db.ebayConnection.count({ where: { user: { role: "USER" }, status: "CONNECTED" } }),
    ]),
  ]);
  const sellerRows = sellers.map(sellerRow);

  const seriesMap = new Map<string, DayPoint>();
  for (let index = days - 1; index >= 0; index--) {
    const date = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
    seriesMap.set(date, { date, revenueCents: 0, netCents: 0 });
  }
  for (const seller of sellers) {
    for (const rawOrder of seller.orders) {
      if (rawOrder.sourcingStatus === "CANCELLED") continue;
      if (rawOrder.status === "REFUNDED" && rawOrder.ebayFinancialsSource !== "ACTUAL") continue;
      const point = seriesMap.get(rawOrder.saleDate.toISOString().slice(0, 10));
      if (!point) continue;
      const breakdown = orderProfitBreakdown(withActualAmazonCost(rawOrder), seller.ebayAdRateBps);
      point.revenueCents += breakdown.revenueCents;
      point.netCents += breakdown.profitCents;
    }
  }

  const totals = sellerRows.reduce((sum, row) => ({
    orders: sum.orders + row.orders,
    units: sum.units + row.units,
    revenueCents: sum.revenueCents + row.revenueCents,
    netCents: sum.netCents + row.netCents,
    activeListings: sum.activeListings + row.activeListings,
    actualFinancialOrders: sum.actualFinancialOrders + row.actualFinancialOrders,
    verifiedCostOrders: sum.verifiedCostOrders + row.verifiedCostOrders,
    unprofitableOrders: sum.unprofitableOrders + row.unprofitableOrders,
  }), {
    orders: 0, units: 0, revenueCents: 0, netCents: 0, activeListings: 0,
    actualFinancialOrders: 0, verifiedCostOrders: 0, unprofitableOrders: 0,
  });

  return {
    totals: {
      ...totals,
      users,
      connectedStores: dataHealth[3],
      marginPct: totals.revenueCents > 0 ? (totals.netCents / totals.revenueCents) * 100 : 0,
    },
    catalog: { all: catalog[0], published: catalog[1], needsReview: catalog[2] },
    health: { openIssues: dataHealth[0], trackingErrors: dataHealth[1], estimatedOrders: dataHealth[2] },
    series: [...seriesMap.values()],
    topSellers: [...sellerRows].sort((left, right) => right.netCents - left.netCents).slice(0, 6),
    atRiskSellers: sellerRows
      .filter((row) => row.netCents < 0 || row.openIssues > 0 || row.ebayStatus !== "CONNECTED")
      .sort((left, right) => left.netCents - right.netCents)
      .slice(0, 6),
  };
}

export async function getAdminSellerDetail(userId: string, days = 30) {
  const cutoff = windowStartUtc(days);
  const user = await db.user.findFirst({
    where: { id: userId, role: "USER" },
    include: {
      ebayConnection: true,
      amazonEmailConnection: true,
      listings: { include: { product: true }, orderBy: { updatedAt: "desc" } },
      syncIssues: { where: { resolution: "OPEN" }, orderBy: { createdAt: "desc" }, take: 20, include: { listing: { select: { title: true } } } },
      orders: {
        where: { saleDate: { gte: cutoff } },
        orderBy: { saleDate: "desc" },
        include: { amazonPurchaseItem: true, listing: { select: { product: { select: { id: true, sku: true, title: true } } } } },
      },
    },
  });
  if (!user) return null;
  const orders = user.orders.map(withActualAmazonCost);
  const totals = summarize(orders, user.ebayAdRateBps);
  const productMap = new Map<string, { id: string; asin: string; title: string; orders: LoadedOrder[] }>();
  for (const order of orders) {
    const product = order.listing.product;
    const group = productMap.get(product.id) ?? { id: product.id, asin: product.sku, title: product.title, orders: [] };
    group.orders.push(order);
    productMap.set(product.id, group);
  }
  const products = [...productMap.values()].map((product) => ({
    id: product.id,
    asin: product.asin,
    title: product.title,
    ...summarize(product.orders.map(withActualAmazonCost), user.ebayAdRateBps),
  })).sort((left, right) => right.netCents - left.netCents);

  const seriesMap = new Map<string, DayPoint>();
  for (let index = days - 1; index >= 0; index--) {
    const date = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
    seriesMap.set(date, { date, revenueCents: 0, netCents: 0 });
  }
  for (const order of orders) {
    if (order.sourcingStatus === "CANCELLED") continue;
    if (order.status === "REFUNDED" && order.ebayFinancialsSource !== "ACTUAL") continue;
    const point = seriesMap.get(order.saleDate.toISOString().slice(0, 10));
    if (!point) continue;
    const breakdown = orderProfitBreakdown(order, user.ebayAdRateBps);
    point.revenueCents += breakdown.revenueCents;
    point.netCents += breakdown.profitCents;
  }
  return { user, orders, totals, products, series: [...seriesMap.values()] };
}
