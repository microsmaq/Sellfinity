import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ebayAdvertisingFeeCents } from "@/lib/fees";
import { formatCents } from "@/lib/money";
import { dailySeries, perItem, summarize, windowStartUtc } from "@/lib/orders/stats";
import { Card, cx } from "@/components/ui";
import { ProfitChart } from "./profit-chart";
import { ImportOrdersButton } from "./import-orders-button";
import { actualAmazonCost } from "@/lib/amazon-email/sync";

export const metadata = { title: "Dashboard — Sellfinity" };

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function Trend({ value, fallback }: { value: number | null; fallback: string }) {
  if (value === null) return <span>{fallback}</span>;
  const positive = value >= 0;
  return (
    <span className={cx("inline-flex items-center gap-1 font-semibold", positive ? "text-emerald-700" : "text-red-600")}>
      <span aria-hidden>{positive ? "↗" : "↘"}</span>
      {Math.abs(value).toFixed(0)}% vs previous 30d
    </span>
  );
}

function MetricCard({ label, value, detail, tone = "default" }: {
  label: string;
  value: string;
  detail: ReactNode;
  tone?: "default" | "positive" | "negative";
}) {
  return (
    <Card className="min-w-0 overflow-hidden p-4 sm:p-5">
      <p className="truncate text-[11px] font-semibold uppercase tracking-[0.11em] text-slate-500">{label}</p>
      <p className={cx(
        "mt-2 truncate text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
        tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : "text-slate-950",
      )}>{value}</p>
      <p className="mt-1.5 min-h-8 text-xs leading-4 text-slate-500">{detail}</p>
    </Card>
  );
}

function ActionIcon({ children, tone }: { children: ReactNode; tone: "indigo" | "amber" | "emerald" | "sky" }) {
  const tones = {
    indigo: "bg-indigo-100 text-indigo-700",
    amber: "bg-amber-100 text-amber-700",
    emerald: "bg-emerald-100 text-emerald-700",
    sky: "bg-sky-100 text-sky-700",
  };
  return <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg font-semibold", tones[tone])}>{children}</span>;
}

function QuickAction({ href, label, detail, icon, tone }: {
  href: string;
  label: string;
  detail: string;
  icon: ReactNode;
  tone: "indigo" | "amber" | "emerald" | "sky";
}) {
  return (
    <Link href={href} className="group flex min-w-0 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md active:translate-y-0">
      <ActionIcon tone={tone}>{icon}</ActionIcon>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-900">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-slate-500">{detail}</span>
      </span>
      <span className="ml-auto text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500" aria-hidden>›</span>
    </Link>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const [orders, activeListings, openIssues, latestSync] = await Promise.all([
    db.order.findMany({
      where: { userId: user.id },
      include: {
        amazonPurchaseItem: true,
        listing: { select: { product: { select: { id: true, title: true, sku: true } } } },
      },
      orderBy: { saleDate: "desc" },
    }),
    db.listing.count({ where: { userId: user.id, status: "ACTIVE" } }),
    db.syncIssue.count({ where: { userId: user.id, resolution: "OPEN" } }),
    db.syncRun.findFirst({
      where: { userId: user.id },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, listingsChecked: true, issuesAutoFixed: true },
    }),
  ]);

  const profitOrders = orders.map((order) => ({
    ...order,
    actualAmazonCostCents: order.amazonPurchaseItem ? actualAmazonCost(order.amazonPurchaseItem) : null,
  }));
  const now = new Date();
  const cutoff30 = windowStartUtc(30, now);
  const cutoff60 = windowStartUtc(60, now);
  const last30 = profitOrders.filter((order) => order.saleDate >= cutoff30);
  const previous30 = profitOrders.filter((order) => order.saleDate >= cutoff60 && order.saleDate < cutoff30);
  const totals30 = summarize(last30, user.ebayAdRateBps);
  const previousTotals = summarize(previous30, user.ebayAdRateBps);
  const totalsAll = summarize(profitOrders, user.ebayAdRateBps);
  const series = dailySeries(last30, 30, now, user.ebayAdRateBps);
  const items = perItem(profitOrders.map((order) => ({
    ...order,
    productId: order.listing.product.id,
    title: order.listing.product.title,
    sku: order.listing.product.sku,
  })), user.ebayAdRateBps);

  const marginPct = totals30.revenueCents > 0 ? (totals30.netCents / totals30.revenueCents) * 100 : 0;
  const averageOrderCents = totals30.orders > 0 ? Math.round(totals30.revenueCents / totals30.orders) : 0;
  const nonRefundedLast30 = last30.filter(
    (order) => order.status !== "REFUNDED" && order.sourcingStatus !== "CANCELLED",
  );
  const exactOrders30 = nonRefundedLast30.filter((order) => order.actualAmazonCostCents !== null).length;
  const awaitingFulfillment = orders.filter((order) =>
    order.status === "PAID" && !["PURCHASED", "SHIPPED", "DELIVERED", "CANCELLED"].includes(order.sourcingStatus)
  ).length;
  const trackingErrors = orders.filter((order) => Boolean(order.ebayTrackingSyncError)).length;
  const revenueChange = changePercent(totals30.revenueCents, previousTotals.revenueCents);
  const profitChange = changePercent(totals30.netCents, previousTotals.netCents);
  const firstName = user.name.trim().split(/\s+/)[0] || "there";
  const dateLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const adRate = (user.ebayAdRateBps / 100).toFixed(2).replace(/\.00$/, "");

  return (
    <div className="space-y-5 sm:space-y-7">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-600">{dateLabel}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Welcome back, {firstName}</h1>
          <p className="mt-1 text-sm text-slate-500">Here’s how your store is performing.</p>
        </div>
        <ImportOrdersButton />
      </header>

      <section className="relative overflow-hidden rounded-3xl bg-slate-950 p-5 text-white shadow-xl shadow-slate-300/40 sm:p-7">
        <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-indigo-500/25 blur-3xl" />
        <div className="absolute -bottom-24 left-1/3 h-56 w-56 rounded-full bg-teal-400/15 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]" />
              Net profit · last 30 days
            </div>
            <p className={cx("mt-3 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl", totals30.netCents < 0 && "text-red-300")}>{formatCents(totals30.netCents)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-300">
              <span className={cx("rounded-full px-2.5 py-1 font-semibold", marginPct >= 15 ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-200")}>{marginPct.toFixed(1)}% margin</span>
              <Trend value={profitChange} fallback={totals30.orders ? "Current 30-day performance" : "Waiting for your first sale"} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.07] p-3 backdrop-blur">
            <div className="min-w-0 px-1">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Orders</p>
              <p className="mt-1 truncate text-lg font-bold tabular-nums">{totals30.orders.toLocaleString()}</p>
            </div>
            <div className="min-w-0 border-x border-white/10 px-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Avg. order</p>
              <p className="mt-1 truncate text-lg font-bold tabular-nums">{formatCents(averageOrderCents)}</p>
            </div>
            <div className="min-w-0 pl-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">All-time</p>
              <p className="mt-1 truncate text-lg font-bold tabular-nums">{formatCents(totalsAll.netCents)}</p>
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Store performance" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <MetricCard label="Revenue" value={formatCents(totals30.revenueCents)} detail={<Trend value={revenueChange} fallback={`${totals30.units} units sold`} />} />
        <MetricCard label="Active listings" value={activeListings.toLocaleString()} detail={latestSync ? `Last sync checked ${latestSync.listingsChecked}` : "Run Smart Sync to verify stock"} />
        <MetricCard label="eBay + ads" value={formatCents(totals30.feesCents)} detail={`${adRate}% ad rate included`} tone="negative" />
        <MetricCard label="Goods + shipping" value={formatCents(totals30.cogsCents)} detail={`${exactOrders30}/${totals30.orders} orders verified`} tone="negative" />
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Shortcuts</p>
            <h2 className="mt-1 text-lg font-bold text-slate-950">Run your store</h2>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <QuickAction href="/arbitrage" label="Find products" detail="Explore profitable matches" icon="⌕" tone="indigo" />
          <QuickAction href="/mirror" label="Mirror a product" detail="Create a listing from Amazon" icon="＋" tone="sky" />
          <QuickAction href="/orders" label="Fulfill orders" detail={awaitingFulfillment ? `${awaitingFulfillment} waiting for action` : "No orders waiting"} icon="→" tone="amber" />
          <QuickAction href="/inventory" label="Smart Sync" detail={openIssues ? `${openIssues} open issue${openIssues === 1 ? "" : "s"}` : "Listings look healthy"} icon="↻" tone="emerald" />
        </div>
      </section>

      {(awaitingFulfillment > 0 || openIssues > 0 || trackingErrors > 0 || exactOrders30 < totals30.orders) && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-100 font-bold text-amber-700">!</span>
            <div className="min-w-0 flex-1">
              <h2 className="font-bold text-amber-950">Needs your attention</h2>
              <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                {awaitingFulfillment > 0 && <Link href="/orders" className="rounded-xl bg-white/80 px-3 py-2.5 font-medium text-amber-950 ring-1 ring-amber-200 hover:bg-white">{awaitingFulfillment} order{awaitingFulfillment === 1 ? "" : "s"} awaiting purchase <span aria-hidden>→</span></Link>}
                {openIssues > 0 && <Link href="/inventory" className="rounded-xl bg-white/80 px-3 py-2.5 font-medium text-amber-950 ring-1 ring-amber-200 hover:bg-white">{openIssues} inventory issue{openIssues === 1 ? "" : "s"} to review <span aria-hidden>→</span></Link>}
                {trackingErrors > 0 && <Link href="/orders" className="rounded-xl bg-white/80 px-3 py-2.5 font-medium text-amber-950 ring-1 ring-amber-200 hover:bg-white">{trackingErrors} tracking update{trackingErrors === 1 ? "" : "s"} failed <span aria-hidden>→</span></Link>}
                {totals30.orders > exactOrders30 && <Link href="/orders" className="rounded-xl bg-white/80 px-3 py-2.5 font-medium text-amber-950 ring-1 ring-amber-200 hover:bg-white">{totals30.orders - exactOrders30} profit total{totals30.orders - exactOrders30 === 1 ? " is" : "s are"} still estimated <span aria-hidden>→</span></Link>}
              </div>
            </div>
          </div>
        </section>
      )}

      {orders.length === 0 ? (
        <Card className="overflow-hidden p-6 text-center sm:p-10">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-indigo-50 text-2xl text-indigo-600">↗</div>
          <h2 className="mt-4 text-lg font-bold text-slate-950">Your sales dashboard is ready</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">Publish your first listing, then import eBay orders to unlock profit trends, top products, and fulfillment alerts.</p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            <Link href="/arbitrage" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500">Find a product</Link>
            <Link href="/listings" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">View listings</Link>
          </div>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden p-4 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Performance</p>
                <h2 className="mt-1 text-lg font-bold text-slate-950">Revenue and net profit</h2>
                <p className="mt-1 text-xs text-slate-500">Last 30 days · hover or press a point for daily values</p>
              </div>
              <div className="flex items-center gap-4 text-xs font-medium text-slate-500">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-indigo-200" />Revenue</span>
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-gradient-to-r from-indigo-500 to-teal-500" />Net profit</span>
              </div>
            </div>
            <div className="mt-4 -mx-1 overflow-hidden"><ProfitChart points={series} /></div>
          </Card>

          <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
            <section className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-950">Top products</h2>
                <Link href="/analytics" className="text-xs font-semibold text-indigo-600 hover:text-indigo-500">View analytics →</Link>
              </div>
              <div className="space-y-2 md:hidden">
                {items.slice(0, 5).map((item, index) => {
                  const itemMargin = item.revenueCents > 0 ? (item.netCents / item.revenueCents) * 100 : 0;
                  return (
                    <Link key={item.productId} href={`/analytics/asins/${encodeURIComponent(item.sku)}`} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm active:bg-slate-50">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-xs font-bold text-slate-500">#{index + 1}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{item.title}</span><span className="mt-0.5 block text-xs text-slate-500">{item.units} sold · {itemMargin.toFixed(0)}% margin</span></span>
                      <span className={cx("text-sm font-bold tabular-nums", item.netCents >= 0 ? "text-emerald-600" : "text-red-600")}>{formatCents(item.netCents)}</span>
                    </Link>
                  );
                })}
              </div>
              <Card className="hidden overflow-hidden md:block">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-200 bg-slate-50/70 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"><th className="px-4 py-3">Product</th><th className="px-4 py-3 text-right">Units</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3 text-right">Net</th></tr></thead>
                  <tbody>{items.slice(0, 7).map((item) => <tr key={item.productId} className="border-b border-slate-100 last:border-0"><td className="max-w-xs px-4 py-3"><Link href={`/analytics/asins/${encodeURIComponent(item.sku)}`} className="block truncate font-semibold text-slate-900 hover:text-indigo-600">{item.title}</Link><p className="mt-0.5 text-xs text-slate-400">{item.sku}</p></td><td className="px-4 py-3 text-right tabular-nums">{item.units}</td><td className="px-4 py-3 text-right tabular-nums text-slate-600">{formatCents(item.revenueCents)}</td><td className={cx("px-4 py-3 text-right font-bold tabular-nums", item.netCents >= 0 ? "text-emerald-600" : "text-red-600")}>{formatCents(item.netCents)}</td></tr>)}</tbody>
                </table>
              </Card>
            </section>

            <section className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-950">Recent orders</h2>
                <Link href="/orders" className="text-xs font-semibold text-indigo-600 hover:text-indigo-500">View all →</Link>
              </div>
              <Card className="divide-y divide-slate-100 overflow-hidden">
                {orders.slice(0, 6).map((order) => {
                  const revenue = order.salePriceCents * order.quantity + order.shippingChargedCents;
                  const amazonCost = order.amazonPurchaseItem ? actualAmazonCost(order.amazonPurchaseItem) : null;
                  const ads = ebayAdvertisingFeeCents(revenue, user.ebayAdRateBps);
                  const net = revenue - order.ebayFeeCents - ads - (amazonCost ?? (order.cogsCents + order.shippingCostCents));
                  return (
                    <Link href="/orders" key={order.id} className="flex items-center gap-3 p-4 transition hover:bg-slate-50">
                      <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold", order.status === "REFUNDED" || order.sourcingStatus === "CANCELLED" ? "bg-red-50 text-red-600" : order.sourcingStatus === "DELIVERED" ? "bg-emerald-50 text-emerald-600" : "bg-indigo-50 text-indigo-600")}>{order.quantity}×</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{order.listing.product.title}</span><span className="mt-0.5 block text-xs text-slate-500">{order.saleDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {order.sourcingStatus.toLowerCase().replaceAll("_", " ")}</span></span>
                      <span className="text-right"><span className="block text-sm font-bold tabular-nums text-slate-900">{formatCents(revenue)}</span><span className={cx("mt-0.5 block text-[11px] font-semibold tabular-nums", order.status === "REFUNDED" || order.sourcingStatus === "CANCELLED" || net < 0 ? "text-red-600" : "text-emerald-600")}>{order.sourcingStatus === "CANCELLED" ? "Cancelled" : order.status === "REFUNDED" ? "Refunded" : `${formatCents(net)} net`}</span></span>
                    </Link>
                  );
                })}
              </Card>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
