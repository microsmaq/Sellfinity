import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getAdminSellerDetail } from "@/lib/admin/reporting";
import { adminUpdateUserPlan } from "@/lib/actions/admin-users";
import { formatCents } from "@/lib/money";
import { Badge, Card, cx, PageHeader, StatCard } from "@/components/ui";
import { ProfitChart } from "../../../dashboard/profit-chart";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireAdmin();
  const { userId } = await params;
  const report = await getAdminSellerDetail(userId, 30);
  if (!report) notFound();
  const { user, totals } = report;
  const includedOrders = report.orders.filter((order) => order.sourcingStatus !== "CANCELLED" && !(order.status === "REFUNDED" && order.ebayFinancialsSource !== "ACTUAL"));
  const actualFees = includedOrders.filter((order) => order.ebayFinancialsSource === "ACTUAL").length;
  const actualCosts = includedOrders.filter((order) => order.actualAmazonCostCents !== null).length;
  const margin = totals.revenueCents ? (totals.netCents / totals.revenueCents) * 100 : 0;

  return <div className="space-y-5">
    <PageHeader title={user.name} subtitle={`${user.email} · Store performance and operational health for the last 30 days.`} actions={<Link href="/admin/users" className="inline-flex min-h-10 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">← All users</Link>} />
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><StatCard label="Revenue" value={formatCents(totals.revenueCents)} sub={`${totals.orders} orders · ${totals.units} units`} /><StatCard label="Net profit" value={formatCents(totals.netCents)} tone={totals.netCents >= 0 ? "positive" : "negative"} sub={`${margin.toFixed(1)}% margin`} /><StatCard label="Active listings" value={user.listings.filter((listing) => listing.status === "ACTIVE").length.toLocaleString()} sub={`${user.listings.length} total listings`} /><StatCard label="Financial coverage" value={totals.orders ? `${Math.round((Math.min(actualFees, actualCosts) / totals.orders) * 100)}%` : "—"} sub={`${actualFees} actual fees · ${actualCosts} actual costs`} /></div>

    <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
      <Card className="overflow-hidden p-4 sm:p-6"><h2 className="font-bold text-slate-950">Revenue and profit</h2><p className="mt-1 text-xs text-slate-500">Daily store performance · last 30 days</p><div className="mt-4 -mx-1"><ProfitChart points={report.series} /></div></Card>
      <Card className="p-5"><h2 className="font-bold text-slate-950">Account management</h2><dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-slate-500">eBay</dt><dd><Badge tone={user.ebayConnection?.status === "CONNECTED" ? "green" : "red"}>{user.ebayConnection?.status ?? "DISCONNECTED"}</Badge></dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">eBay store</dt><dd className="truncate font-medium">{user.ebayConnection?.ebayUsername ?? "—"}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Amazon email</dt><dd><Badge tone={user.amazonEmailConnection?.status === "CONNECTED" ? "green" : "amber"}>{user.amazonEmailConnection?.status ?? "DISCONNECTED"}</Badge></dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Member since</dt><dd className="font-medium">{user.createdAt.toLocaleDateString()}</dd></div></dl><form action={adminUpdateUserPlan} className="mt-5 border-t border-slate-200 pt-4"><input type="hidden" name="userId" value={user.id}/><label className="text-xs font-semibold text-slate-600">Subscription plan<select name="plan" defaultValue={user.plan} className="mt-1.5 block min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"><option value="FREE">Free</option><option value="PRO">Pro</option><option value="SCALE">Scale</option></select></label><button className="mt-2 min-h-10 w-full rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500">Update plan</button></form></Card>
    </div>

    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="overflow-hidden"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Product profitability</h2><p className="text-xs text-slate-500">Best and worst performers for this store</p></div><div className="divide-y divide-slate-100">{report.products.slice(0, 12).map((product) => <Link key={product.id} href={`/analytics/asins/${encodeURIComponent(product.asin)}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{product.title}</span><span className="block text-xs text-slate-500">{product.asin} · {product.units} sold</span></span><span className={cx("font-bold", product.netCents >= 0 ? "text-emerald-600" : "text-red-600")}>{formatCents(product.netCents)}</span></Link>)}{report.products.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No product sales in this period.</p>}</div></Card>
      <Card className="overflow-hidden"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Open store issues</h2><p className="text-xs text-slate-500">Inventory and supplier mismatches requiring attention</p></div><div className="divide-y divide-slate-100">{user.syncIssues.map((issue) => <div key={issue.id} className="px-5 py-3.5"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-semibold text-slate-900">{issue.listing.title}</p><Badge tone="amber">{issue.type.replaceAll("_", " ")}</Badge></div><p className="mt-1 text-xs text-slate-500">Detected {issue.createdAt.toLocaleString()}</p></div>)}{user.syncIssues.length === 0 && <p className="p-8 text-center text-sm text-emerald-700">No open inventory issues.</p>}</div></Card>
    </div>
  </div>;
}
