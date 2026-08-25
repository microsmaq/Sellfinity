import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRainforestEfficiencySummary } from "@/lib/mirror/rainforest";
import { Badge, Card, PageHeader, StatCard } from "@/components/ui";

export const metadata = { title: "Data operations — Sellfinity" };

export default async function AdminDataPage() {
  await requireAdmin();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [rainforest, counts, issueGroups, recentFailures] = await Promise.all([
    getRainforestEfficiencySummary(),
    Promise.all([
      db.adminArbitrageProduct.count({ where: { status: { not: "ARCHIVED" }, OR: [{ amazonRefreshedAt: null }, { amazonRefreshedAt: { lt: dayAgo } }] } }),
      db.adminArbitrageProduct.count({ where: { amazonInStock: false, status: "PUBLISHED" } }),
      db.adminArbitrageProduct.count({ where: { status: { not: "ARCHIVED" }, OR: [{ ebayItemId: null }, { lastResearchedAt: null }, { lastResearchedAt: { lt: dayAgo } }] } }),
      db.syncIssue.count({ where: { resolution: "OPEN" } }),
      db.order.count({ where: { ebayTrackingSyncError: { not: null } } }),
      db.order.count({ where: { ebayFinancialsSource: "ESTIMATED" } }),
      db.ebayConnection.count({ where: { user: { role: "USER" }, status: { not: "CONNECTED" } } }),
      db.amazonEmailConnection.count({ where: { lastSyncError: { not: null } } }),
      db.mirrorBatchItem.count({ where: { status: "FAILED" } }),
      db.syncRun.count({ where: { finishedAt: null, startedAt: { lt: hourAgo } } }),
    ]),
    db.syncIssue.groupBy({ by: ["type"], where: { resolution: "OPEN" }, _count: { _all: true }, orderBy: { _count: { type: "desc" } } }),
    db.mirrorBatchItem.findMany({ where: { status: "FAILED" }, orderBy: { completedAt: "desc" }, take: 12, include: { batch: { select: { source: true, user: { select: { id: true, name: true, email: true } } } } } }),
  ]);
  const [staleAmazon, publishedUnavailable, staleEbay, openIssues, trackingErrors, estimatedFinancials, disconnectedEbay, amazonEmailErrors, failedBatchItems, stuckSyncRuns] = counts;
  const cacheTotal = rainforest.cacheHits + rainforest.providerRequests;
  const cacheRate = cacheTotal ? Math.round((rainforest.cacheHits / cacheTotal) * 100) : 0;

  return <div className="space-y-5">
    <PageHeader title="Data operations" subtitle="Monitor shared catalog freshness, marketplace connections, background work, API efficiency, and failures from one place." actions={<Link href="/admin/arbitrage" className="inline-flex min-h-10 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Open product intelligence</Link>} />
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4"><StatCard label="Stale Amazon records" value={staleAmazon.toLocaleString()} sub="Older than 24 hours or never refreshed" tone={staleAmazon ? "negative" : "positive"}/><StatCard label="Stale eBay research" value={staleEbay.toLocaleString()} sub="Missing or older than 24 hours" tone={staleEbay ? "negative" : "positive"}/><StatCard label="Rainforest cache hit" value={`${cacheRate}%`} sub={`${rainforest.providerRequests} paid · ${rainforest.cacheHits} cached`}/><StatCard label="Credits remaining" value={rainforest.account?.creditsRemaining?.toLocaleString() ?? "—"} sub={rainforest.account ? `${rainforest.account.creditsUsed.toLocaleString()} used` : "Provider account unavailable"}/></section>

    <div className="grid gap-5 xl:grid-cols-3">
      <Card className="p-5"><div className="flex items-center justify-between"><h2 className="font-bold text-slate-950">Catalog health</h2><Badge tone={publishedUnavailable ? "red" : "green"}>{publishedUnavailable ? "Action needed" : "Healthy"}</Badge></div><dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between"><dt className="text-slate-500">Published but unavailable</dt><dd className="font-bold text-red-600">{publishedUnavailable}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Amazon data stale</dt><dd className="font-semibold">{staleAmazon}</dd></div><div className="flex justify-between"><dt className="text-slate-500">eBay research stale</dt><dd className="font-semibold">{staleEbay}</dd></div></dl><Link href="/admin/arbitrage?sort=researched&dir=asc" className="mt-5 inline-flex text-xs font-semibold text-indigo-600">Review oldest products →</Link></Card>
      <Card className="p-5"><div className="flex items-center justify-between"><h2 className="font-bold text-slate-950">Store connections</h2><Badge tone={disconnectedEbay || amazonEmailErrors ? "amber" : "green"}>{disconnectedEbay + amazonEmailErrors} issues</Badge></div><dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between"><dt className="text-slate-500">eBay disconnected</dt><dd className="font-semibold">{disconnectedEbay}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Amazon email errors</dt><dd className="font-semibold">{amazonEmailErrors}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Estimated financial records</dt><dd className="font-semibold">{estimatedFinancials}</dd></div></dl><Link href="/admin/users?filter=attention" className="mt-5 inline-flex text-xs font-semibold text-indigo-600">Review affected stores →</Link></Card>
      <Card className="p-5"><div className="flex items-center justify-between"><h2 className="font-bold text-slate-950">Job health</h2><Badge tone={trackingErrors || failedBatchItems || stuckSyncRuns ? "amber" : "green"}>{trackingErrors + failedBatchItems + stuckSyncRuns} problems</Badge></div><dl className="mt-4 space-y-3 text-sm"><div className="flex justify-between"><dt className="text-slate-500">Failed tracking uploads</dt><dd className="font-semibold">{trackingErrors}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Failed publishing items</dt><dd className="font-semibold">{failedBatchItems}</dd></div><div className="flex justify-between"><dt className="text-slate-500">Possibly stuck sync runs</dt><dd className="font-semibold">{stuckSyncRuns}</dd></div></dl></Card>
    </div>

    <div className="grid gap-5 xl:grid-cols-[0.7fr_1.3fr]">
      <Card className="overflow-hidden"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Open sync issues</h2><p className="text-xs text-slate-500">Grouped by root cause</p></div><div className="divide-y divide-slate-100">{issueGroups.map((group) => <div key={group.type} className="flex items-center justify-between px-5 py-3.5"><span className="text-sm font-semibold text-slate-700">{group.type.replaceAll("_", " ")}</span><Badge tone="amber">{group._count._all}</Badge></div>)}{openIssues === 0 && <p className="p-8 text-center text-sm text-emerald-700">No open sync issues.</p>}</div></Card>
      <Card className="overflow-hidden"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-950">Recent publishing failures</h2><p className="text-xs text-slate-500">Use the user report to identify the affected store, then retry only failed items.</p></div><div className="divide-y divide-slate-100">{recentFailures.map((item) => <div key={item.id} className="px-5 py-3.5"><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 truncate text-sm font-semibold text-slate-900">{item.title ?? item.inputUrl}</p><Link href={`/admin/users/${item.batch.user.id}`} className="text-xs font-semibold text-indigo-600">{item.batch.user.name}</Link></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-red-600">{item.error ?? "Unknown publishing failure"}</p></div>)}{recentFailures.length === 0 && <p className="p-8 text-center text-sm text-emerald-700">No publishing failures recorded.</p>}</div></Card>
    </div>
  </div>;
}
