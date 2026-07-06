// P&L aggregation over recorded orders. Refunded orders are excluded from
// money totals (the buyer got their money back) but surfaced as a count.

export type OrderFacts = {
  quantity: number;
  salePriceCents: number;
  shippingChargedCents: number;
  ebayFeeCents: number;
  shippingCostCents: number;
  cogsCents: number;
  status: string;
  saleDate: Date;
};

export type Totals = {
  orders: number;
  units: number;
  revenueCents: number;
  feesCents: number;
  cogsCents: number; // cost of goods + outbound shipping
  netCents: number;
  refunded: number;
};

export function summarize(orders: OrderFacts[]): Totals {
  const t: Totals = {
    orders: 0, units: 0, revenueCents: 0, feesCents: 0, cogsCents: 0, netCents: 0, refunded: 0,
  };
  for (const o of orders) {
    if (o.status === "REFUNDED") {
      t.refunded++;
      continue;
    }
    const revenue = o.salePriceCents * o.quantity + o.shippingChargedCents;
    const costs = o.cogsCents + o.shippingCostCents;
    t.orders++;
    t.units += o.quantity;
    t.revenueCents += revenue;
    t.feesCents += o.ebayFeeCents;
    t.cogsCents += costs;
    t.netCents += revenue - o.ebayFeeCents - costs;
  }
  return t;
}

/**
 * Start (UTC midnight) of the `days`-day window ending today — the same
 * window dailySeries buckets, so card totals and the chart always agree.
 */
export function windowStartUtc(days: number, now = new Date()): Date {
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export type DayPoint = { date: string; revenueCents: number; netCents: number };

/** Daily revenue/net for the last `days` days (inclusive of today), zero-filled. */
export function dailySeries(orders: OrderFacts[], days: number, now = new Date()): DayPoint[] {
  const points = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    points.set(key, { date: key, revenueCents: 0, netCents: 0 });
  }
  for (const o of orders) {
    if (o.status === "REFUNDED") continue;
    const key = o.saleDate.toISOString().slice(0, 10);
    const point = points.get(key);
    if (!point) continue;
    const revenue = o.salePriceCents * o.quantity + o.shippingChargedCents;
    point.revenueCents += revenue;
    point.netCents += revenue - o.ebayFeeCents - o.cogsCents - o.shippingCostCents;
  }
  return [...points.values()];
}

export type ItemPnl = Totals & { productId: string; title: string; sku: string };

export function perItem(
  orders: (OrderFacts & { productId: string; title: string; sku: string })[],
): ItemPnl[] {
  const groups = new Map<string, (typeof orders)[number][]>();
  for (const o of orders) {
    const list = groups.get(o.productId) ?? [];
    list.push(o);
    groups.set(o.productId, list);
  }
  return [...groups.entries()]
    .map(([productId, group]) => ({
      productId,
      title: group[0].title,
      sku: group[0].sku,
      ...summarize(group),
    }))
    .sort((a, b) => b.netCents - a.netCents);
}
