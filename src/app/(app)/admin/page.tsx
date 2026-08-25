import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getAdminPlatformOverview } from "@/lib/admin/reporting";
import { formatCents } from "@/lib/money";
import { Badge, Card, cx, PageHeader, StatCard } from "@/components/ui";
import { ProfitChart } from "../dashboard/profit-chart";

export const metadata = { title: "Admin dashboard — Sellfinity" };

function percentage(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}%` : "—";
}

export default async function AdminDashboardPage() {
  await requireAdmin();
  const overview = await getAdminPlatformOverview(30);
  const { totals, catalog, health } = overview;
  const alerts = [
    health.openIssues ? { label: `${health.openIssues} open listing issue${health.openIssues === 1 ? "" : "s"}`, href: "/admin/data", tone: "amber" as const } : null,
    health.trackingErrors ? { label: `${health.trackingErrors} failed tracking update${health.trackingErrors === 1 ? "" : "s"}`, href: "/admin/data", tone: "red" as const } : null,
    health.estimatedOrders ? { label: `${health.estimatedOrders} order${health.estimatedOrders === 1 ? "" : "s"} still use estimated eBay fees`, href: "/admin/data", tone: "amber" as const } : null,
    catalog.needsReview ? { label: `${catalog.needsReview} catalog product${catalog.needsReview === 1 ? "" : "s"} need review`, href: "/admin/arbitrage?status=NO_MATCH", tone: "amber" as const } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin dashboard"
        subtitle="Platform profitability, seller health, catalog quality, and operational issues from the last 30 days."
        actions={<Link href="/admin/arbitrage" className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500">Find profitable products</Link>}
      />

      <section className="relative overflow-hidden rounded-3xl bg-slate-950 p-5 text-white shadow-xl shadow-slate-300/40 sm:p-7">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-indigo-500/25 blur-3xl" />
        <div className="absolute -bottom-24 left-1/3 h-56 w-56 rounded-full bg-emerald-400/15 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Platform net profit · 30 days</p>
            <p className={cx("mt-3 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl", totals.netCents < 0 && "text-red-300")}>{formatCents(totals.netCents)}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className={cx("rounded-full px-2.5 py-1 font-semibold", totals.marginPct >= 10 ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-200")}>{totals.marginPct.toFixed(1)}% margin</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-slate-200">{totals.orders.toLocaleString()} orders</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-slate-200">{totals.unprofitableOrders} unprofitable</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.07] p-3 backdrop-blur">
            <div><p className="text-[10px] uppercase text-slate-400">Revenue</p><p className="mt-1 truncate text-lg font-bold">{formatCents(totals.revenueCents)}</p></div>
            <div className="border-x border-white/10 px-3"><p className="text-[10px] uppercase text-slate-400">Users</p><p className="mt-1 text-lg font-bold">{totals.users}</p></div>
            <div className="pl-2"><p className="text-[10px] uppercase text-slate-400">Stores live</p><p className="mt-1 text-lg font-bold">{totals.connectedStores}</p></div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Active listings" value={totals.activeListings.toLocaleString()} sub={`${totals.units.toLocaleString()} units sold`} />
        <StatCard label="Catalog published" value={catalog.published.toLocaleString()} sub={`${catalog.all.toLocaleString()} total products`} />
        <StatCard label="Actual eBay fees" value={percentage(totals.actualFinancialOrders, totals.orders)} sub={`${totals.actualFinancialOrders}/${totals.orders} orders finalized`} />
        <StatCard label="Verified Amazon cost" value={percentage(totals.verifiedCostOrders, totals.orders)} sub={`${totals.verifiedCostOrders}/${totals.orders} purchases matched`} />
      </section>

      {alerts.length > 0 && (
        <Card className="overflow-hidden border-amber-200 bg-amber-50/60 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3"><div><p className="font-bold text-amber-950">Needs attention</p><p className="mt-0.5 text-xs text-amber-800">Items that can affect seller profitability or data accuracy.</p></div><Badge tone="amber">{alerts.length} groups</Badge></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {alerts.map((alert) => <Link key={alert.label} href={alert.href} className="flex items-center justify-between rounded-xl bg-white/80 px-3 py-2.5 text-sm font-semibold text-slate-800 ring-1 ring-amber-200 transition hover:bg-white"><span>{alert.label}</span><span aria-hidden>→</span></Link>)}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-bold text-slate-950">Revenue and realized profit</h2><p className="mt-1 text-xs text-slate-500">Daily performance across all seller stores · last 30 days</p></div><div className="flex gap-4 text-xs font-medium text-slate-500"><span>■ Revenue</span><span className="text-indigo-600">— Net profit</span></div></div>
        <div className="mt-4 -mx-1 overflow-hidden"><ProfitChart points={overview.series} /></div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5 sm:px-5"><div><h2 className="font-bold text-slate-950">Most profitable stores</h2><p className="text-xs text-slate-500">Net profit in the last 30 days</p></div><Link href="/admin/users?sort=profit" className="text-xs font-semibold text-indigo-600">View all →</Link></div>
          <div className="divide-y divide-slate-100">{overview.topSellers.map((seller, index) => <Link key={seller.id} href={`/admin/users/${seller.id}`} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-xs font-bold text-indigo-600">#{index + 1}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{seller.name}</span><span className="block truncate text-xs text-slate-500">{seller.orders} orders · {seller.marginPct.toFixed(1)}% margin</span></span><span className={cx("text-sm font-bold tabular-nums", seller.netCents >= 0 ? "text-emerald-600" : "text-red-600")}>{formatCents(seller.netCents)}</span></Link>)}{overview.topSellers.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No seller sales yet.</p>}</div>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5 sm:px-5"><div><h2 className="font-bold text-slate-950">Stores at risk</h2><p className="text-xs text-slate-500">Losses, open issues, or disconnected eBay accounts</p></div><Link href="/admin/users?filter=attention" className="text-xs font-semibold text-indigo-600">Review all →</Link></div>
          <div className="divide-y divide-slate-100">{overview.atRiskSellers.map((seller) => <Link key={seller.id} href={`/admin/users/${seller.id}`} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5"><span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", seller.ebayStatus === "CONNECTED" && !seller.openIssues && seller.netCents >= 0 ? "bg-emerald-400" : "bg-amber-400")} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{seller.name}</span><span className="block truncate text-xs text-slate-500">{seller.ebayStatus !== "CONNECTED" ? "eBay disconnected" : seller.openIssues ? `${seller.openIssues} open issues` : "Negative profit"}</span></span><span className={cx("text-sm font-bold", seller.netCents < 0 ? "text-red-600" : "text-slate-700")}>{formatCents(seller.netCents)}</span></Link>)}{overview.atRiskSellers.length === 0 && <p className="p-8 text-center text-sm text-emerald-700">All stores look healthy.</p>}</div>
        </Card>
      </div>
    </div>
  );
}
