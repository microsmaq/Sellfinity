import Link from "next/link";
import { Card, StatCard } from "@/components/ui";
import type { getAdminCatalogHealth } from "@/lib/admin/catalog-reporting";
import { catalogDay, CATALOG_REPORT_TIME_ZONE } from "@/lib/admin/catalog-stats";

type Health = Awaited<ReturnType<typeof getAdminCatalogHealth>>;
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString("en-US", { timeZone: CATALOG_REPORT_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "Not recorded yet";
}
export function CatalogHealth({ data }: { data: Health }) {
  const trackingDay = data.trackingStartedAt ? catalogDay(new Date(data.trackingStartedAt)) : null;
  const max = Math.max(1, ...data.series.flatMap((point) => [point.added, point.refreshed]));
  const labels = new Set([0, 7, 14, 21, 29]);
  return <section className="space-y-4" aria-labelledby="catalog-health-heading">
    <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 id="catalog-health-heading" className="text-lg font-bold text-slate-950">Catalog activity & data freshness</h2><p className="mt-1 text-xs text-slate-500">Shared Amazon database · daily unique products · Pacific time</p></div><Link href="/admin/arbitrage" className="text-sm font-semibold text-indigo-600">Manage catalog →</Link></div>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatCard label="Added today" value={data.today.added.toLocaleString()} sub={`${data.series.reduce((sum, day) => sum + day.added, 0).toLocaleString()} added over 30 days`} />
      <StatCard label="Updated today" value={data.today.refreshed.toLocaleString()} sub="Price / availability snapshots saved" />
      <StatCard label="Still need updating" value={data.needsUpdate.toLocaleString()} sub="Older than 24h or no saved update" />
      <StatCard label="Fresh data" value={`${data.total ? Math.round(data.fresh / data.total * 100) : 0}%`} sub={`${data.fresh.toLocaleString()} of ${data.total.toLocaleString()} active catalog items`} />
    </div>
    <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
      <Card className="min-w-0 p-4 sm:p-5"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold text-slate-900">Daily catalog activity · 30 days</h3><div className="flex gap-3 text-xs"><span className="text-indigo-600">■ Added</span><span className="text-emerald-600">■ Updated</span></div></div>
        <svg viewBox="0 0 660 230" className="mt-4 h-auto w-full" role="img" aria-label="Daily unique Amazon catalog products added and updated over the last thirty days">
          <title>Catalog additions and saved updates</title>
          {[0, 0.5, 1].map((ratio) => <g key={ratio}><line x1="30" x2="650" y1={190 - ratio * 170} y2={190 - ratio * 170} stroke="#e2e8f0" strokeDasharray="4 4" /><text x="25" y={194 - ratio * 170} textAnchor="end" fontSize="11" fill="#64748b">{Math.round(max * ratio)}</text></g>)}
          {data.series.map((point, index) => {
            const x = 35 + index * 20.5;
            const known = trackingDay !== null && point.date >= trackingDay;
            return <g key={point.date}><title>{`${point.date}: ${point.added} added; ${known ? `${point.refreshed} updated; ${point.checked} browser checks started` : "update history not tracked yet"}`}</title><rect x={x} y={190 - point.added / max * 170} width="7" height={point.added / max * 170} fill="#6366f1" rx="2" />{known && <rect x={x + 8} y={190 - point.refreshed / max * 170} width="7" height={point.refreshed / max * 170} fill="#10b981" rx="2" />}{labels.has(index) && <text x={x + 4} y="216" fontSize="12" textAnchor={index === 29 ? "end" : "start"} fill="#64748b">{point.date.slice(5)}</text>}</g>;
          })}
        </svg>
        <p className="text-[11px] text-slate-500">An item counts once per day, even if checked repeatedly. Saved updates include unchanged prices and confirmed unavailability. Update/check history begins {timestamp(data.trackingStartedAt)}; earlier update counts are unknown.</p>
        <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-indigo-600">View daily numbers</summary><div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-white text-slate-500"><tr><th className="py-2">Date</th><th>Added</th><th>Updated</th><th>Checked</th></tr></thead><tbody>{[...data.series].reverse().map((point) => <tr key={point.date} className="border-t border-slate-100"><td className="py-2">{point.date}</td><td>{point.added}</td><td>{trackingDay && point.date >= trackingDay ? point.refreshed : "—"}</td><td>{trackingDay && point.date >= trackingDay ? point.checked : "—"}</td></tr>)}</tbody></table></div></details>
      </Card>
      <Card className="p-4 sm:p-5"><h3 className="font-semibold text-slate-900">How fresh is the catalog?</h3><div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${data.fresh} fresh items; ${data.needsUpdate} need updating`}>{data.buckets.map((bucket) => <div key={bucket.label} title={`${bucket.label}: ${bucket.count}`} style={{ width: `${data.total ? bucket.count / data.total * 100 : 0}%`, background: bucket.color }} />)}</div><div className="mt-3 space-y-2">{data.buckets.map((bucket) => <div key={bucket.label} className="flex items-center justify-between text-xs"><span className="flex items-center gap-2 text-slate-600"><span className="h-2 w-2 rounded-full" style={{ background: bucket.color }} />{bucket.label}</span><span className="font-semibold tabular-nums text-slate-900">{bucket.count.toLocaleString()}</span></div>)}</div>
        <dl className="mt-5 space-y-3 border-t border-slate-100 pt-4 text-xs"><div><dt className="text-slate-500">Last saved Amazon update</dt><dd className="mt-1 font-semibold text-slate-900">{timestamp(data.lastUpdated)}</dd></div><div><dt className="text-slate-500">Last Amazon check / update</dt><dd className="mt-1 font-semibold text-slate-900">{timestamp(data.lastChecked)}</dd></div><div className="flex justify-between gap-2"><dt className="text-slate-500">Never checked</dt><dd className="font-semibold">{data.needsFirstCheck.toLocaleString()}</dd></div><div className="flex justify-between gap-2"><dt className="text-slate-500">Attempted, no newer saved update</dt><dd className="font-semibold">{data.attemptedWithoutUpdate.toLocaleString()}</dd></div><div className="flex justify-between gap-2"><dt className="text-slate-500">Marked unavailable</dt><dd className="font-semibold">{data.unavailable.toLocaleString()}</dd></div></dl><p className="mt-3 text-[11px] text-slate-500">Freshness uses the saved Amazon data timestamp—not browser attempts or unrelated catalog edits. Archived items are excluded from freshness totals.</p>
      </Card>
    </div>
  </section>;
}
