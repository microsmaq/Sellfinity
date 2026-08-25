import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getAdminSellerRows, type AdminSellerRow } from "@/lib/admin/reporting";
import { formatCents } from "@/lib/money";
import { Badge, Card, cx, Input, PageHeader, StatCard } from "@/components/ui";

export const metadata = { title: "Users & stores — Sellfinity" };

type SortKey = "profit" | "revenue" | "orders" | "listings" | "name" | "newest";

function sortRows(rows: AdminSellerRow[], key: SortKey): AdminSellerRow[] {
  return [...rows].sort((left, right) => {
    if (key === "name") return left.name.localeCompare(right.name);
    if (key === "newest") return right.createdAt.getTime() - left.createdAt.getTime();
    if (key === "revenue") return right.revenueCents - left.revenueCents;
    if (key === "orders") return right.orders - left.orders;
    if (key === "listings") return right.activeListings - left.activeListings;
    return right.netCents - left.netCents;
  });
}

function connectionTone(status: string): "green" | "amber" | "red" {
  return status === "CONNECTED" ? "green" : status === "SANDBOX" ? "amber" : "red";
}

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const raw = await searchParams;
  const query = typeof raw.q === "string" ? raw.q.trim().toLowerCase() : "";
  const filter = typeof raw.filter === "string" ? raw.filter : "all";
  const sort: SortKey = ["profit", "revenue", "orders", "listings", "name", "newest"].includes(String(raw.sort)) ? raw.sort as SortKey : "profit";
  const page = Math.max(1, Number(raw.page ?? 1) || 1);
  const allRows = await getAdminSellerRows(30);
  const filtered = sortRows(allRows.filter((row) => {
    const matchesSearch = !query || `${row.name} ${row.email} ${row.ebayUsername ?? ""}`.toLowerCase().includes(query);
    const matchesFilter = filter !== "attention" || row.netCents < 0 || row.openIssues > 0 || row.ebayStatus !== "CONNECTED";
    return matchesSearch && matchesFilter;
  }), sort);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const totals = allRows.reduce((sum, row) => ({ revenue: sum.revenue + row.revenueCents, profit: sum.profit + row.netCents, orders: sum.orders + row.orders, connected: sum.connected + Number(row.ebayStatus === "CONNECTED") }), { revenue: 0, profit: 0, orders: 0, connected: 0 });
  const pageHref = (nextPage: number) => `/admin/users?${new URLSearchParams({ ...(query && { q: query }), ...(filter !== "all" && { filter }), sort, page: String(nextPage) }).toString()}`;

  return (
    <div className="space-y-5">
      <PageHeader title="Users & stores" subtitle="Search every seller, compare store profitability, verify data coverage, and investigate operational risk." />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Seller accounts" value={allRows.length.toLocaleString()} sub={`${totals.connected} eBay stores connected`} />
        <StatCard label="30-day revenue" value={formatCents(totals.revenue)} sub={`${totals.orders.toLocaleString()} orders`} />
        <StatCard label="30-day net profit" value={formatCents(totals.profit)} tone={totals.profit >= 0 ? "positive" : "negative"} />
        <StatCard label="Need attention" value={allRows.filter((row) => row.netCents < 0 || row.openIssues || row.ebayStatus !== "CONNECTED").length.toLocaleString()} sub="Loss, connection, or sync risk" />
      </section>

      <Card className="overflow-hidden">
        <form action="/admin/users" method="get" className="grid gap-2 border-b border-slate-200 p-4 sm:grid-cols-[1fr_180px_180px_auto] sm:p-5">
          <Input name="q" defaultValue={typeof raw.q === "string" ? raw.q : ""} placeholder="Search user, email, or eBay store…" />
          <select name="filter" defaultValue={filter} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm"><option value="all">All stores</option><option value="attention">Needs attention</option></select>
          <select name="sort" defaultValue={sort} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm"><option value="profit">Highest profit</option><option value="revenue">Highest revenue</option><option value="orders">Most orders</option><option value="listings">Most listings</option><option value="name">Name A–Z</option><option value="newest">Newest users</option></select>
          <button className="min-h-10 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500">Apply</button>
        </form>

        <div className="space-y-3 bg-slate-50/60 p-3 md:hidden">
          {rows.map((row) => <Link key={row.id} href={`/admin/users/${row.id}`} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition active:scale-[.99]"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-bold text-slate-950">{row.name}</p><p className="truncate text-xs text-slate-500">{row.email}</p></div><Badge tone={connectionTone(row.ebayStatus)}>{row.ebayStatus === "CONNECTED" ? "eBay live" : "Disconnected"}</Badge></div><div className="mt-3 grid grid-cols-3 rounded-xl bg-slate-50 p-3 text-center"><div><p className="text-[10px] uppercase text-slate-400">Revenue</p><p className="mt-1 truncate text-sm font-bold">{formatCents(row.revenueCents)}</p></div><div className="border-x border-slate-200"><p className="text-[10px] uppercase text-slate-400">Profit</p><p className={cx("mt-1 truncate text-sm font-bold", row.netCents >= 0 ? "text-emerald-600" : "text-red-600")}>{formatCents(row.netCents)}</p></div><div><p className="text-[10px] uppercase text-slate-400">Orders</p><p className="mt-1 text-sm font-bold">{row.orders}</p></div></div><p className="mt-3 text-xs text-slate-500">{row.activeListings} active listings · {row.openIssues} open issues · {row.marginPct.toFixed(1)}% margin</p></Link>)}
        </div>

        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[1050px] text-sm"><thead><tr className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"><th className="px-5 py-3">User / store</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Connections</th><th className="px-4 py-3 text-right">Listings</th><th className="px-4 py-3 text-right">Orders</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3 text-right">Net profit</th><th className="px-4 py-3 text-right">Coverage</th><th className="px-4 py-3 text-right">Issues</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50"><td className="px-5 py-4"><Link href={`/admin/users/${row.id}`} className="font-semibold text-slate-950 hover:text-indigo-600">{row.name}</Link><p className="mt-0.5 text-xs text-slate-500">{row.email}{row.ebayUsername ? ` · ${row.ebayUsername}` : ""}</p></td><td className="px-4 py-4"><Badge tone="indigo">{row.plan}</Badge></td><td className="px-4 py-4"><Badge tone={connectionTone(row.ebayStatus)}>eBay {row.ebayStatus === "CONNECTED" ? "live" : "off"}</Badge></td><td className="px-4 py-4 text-right">{row.activeListings}/{row.totalListings}</td><td className="px-4 py-4 text-right">{row.orders}</td><td className="px-4 py-4 text-right">{formatCents(row.revenueCents)}</td><td className={cx("px-4 py-4 text-right font-bold", row.netCents >= 0 ? "text-emerald-600" : "text-red-600")}>{formatCents(row.netCents)}<p className="text-[10px] font-medium text-slate-400">{row.marginPct.toFixed(1)}%</p></td><td className="px-4 py-4 text-right"><p>{row.actualFinancialOrders}/{row.orders} fees</p><p className="text-[10px] text-slate-400">{row.verifiedCostOrders}/{row.orders} costs</p></td><td className="px-4 py-4 text-right">{row.openIssues || row.unprofitableOrders ? <Badge tone="amber">{row.openIssues + row.unprofitableOrders}</Badge> : <Badge tone="green">Clear</Badge>}</td></tr>)}</tbody></table></div>
        {rows.length === 0 && <p className="p-10 text-center text-sm text-slate-500">No seller accounts match these filters.</p>}
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-500 sm:px-5"><span>{filtered.length ? `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filtered.length)} of ${filtered.length}` : "0 results"}</span><div className="flex gap-2"><Link aria-disabled={currentPage <= 1} href={pageHref(Math.max(1, currentPage - 1))} className={cx("rounded-lg border px-3 py-1.5 font-semibold", currentPage <= 1 ? "pointer-events-none text-slate-300" : "text-slate-700 hover:bg-slate-50")}>Previous</Link><Link aria-disabled={currentPage >= pages} href={pageHref(Math.min(pages, currentPage + 1))} className={cx("rounded-lg border px-3 py-1.5 font-semibold", currentPage >= pages ? "pointer-events-none text-slate-300" : "text-slate-700 hover:bg-slate-50")}>Next</Link></div></div>
      </Card>
    </div>
  );
}
