/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { Badge, Card, PageHeader, StatCard } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { AsinReport } from "@/lib/analytics/asin-report";

function percent(value: number | null): string {
  if (value === null) return "—";
  const normalized = value > 100 ? value / 100 : value;
  return `${normalized.toFixed(2).replace(/\.00$/, "")}%`;
}

function SalesChart({ report }: { report: AsinReport }) {
  const width = 900;
  const height = 260;
  const top = 20;
  const bottom = 36;
  const chartHeight = height - top - bottom;
  const maxRevenue = Math.max(1, ...report.daily.map((point) => point.revenueCents));
  const slot = width / report.daily.length;
  const points = report.daily.map((point, index) => {
    const x = index * slot + slot / 2;
    const y = top + chartHeight - (point.revenueCents / maxRevenue) * chartHeight;
    return `${x},${y}`;
  }).join(" ");
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[720px] w-full" role="img" aria-label="Daily sales and revenue over the last 30 days">
        {[0, 0.5, 1].map((ratio) => (
          <line key={ratio} x1="0" x2={width} y1={top + chartHeight * ratio} y2={top + chartHeight * ratio} stroke="#e2e8f0" />
        ))}
        {report.daily.map((point, index) => {
          const barHeight = (point.units / Math.max(1, ...report.daily.map((row) => row.units))) * chartHeight;
          return (
            <g key={point.date}>
              <rect x={index * slot + slot * 0.22} y={top + chartHeight - barHeight} width={Math.max(2, slot * 0.56)} height={barHeight} rx="2" fill="#c7d2fe">
                <title>{point.date}: {point.units} units · {formatCents(point.revenueCents)}</title>
              </rect>
              {(index === 0 || index === report.daily.length - 1 || index % 7 === 0) && (
                <text x={index * slot + slot / 2} y={height - 12} textAnchor="middle" fontSize="11" fill="#64748b">
                  {new Date(`${point.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                </text>
              )}
            </g>
          );
        })}
        <polyline points={points} fill="none" stroke="#4f46e5" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex items-center justify-center gap-5 text-xs text-slate-500">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-indigo-200" /> Units sold</span>
        <span><span className="mr-1 inline-block h-0.5 w-4 align-middle bg-indigo-600" /> Revenue</span>
      </div>
    </div>
  );
}

function PriceChart({ report }: { report: AsinReport }) {
  const events = report.priceHistory.slice(-40);
  if (events.length < 2) return null;
  const width = 900;
  const height = 210;
  const prices = events.map((event) => event.priceCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(1, max - min);
  const points = events.map((event, index) => {
    const x = 20 + index * ((width - 40) / Math.max(1, events.length - 1));
    const y = 20 + (1 - (event.priceCents - min) / range) * 150;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[700px] w-full" role="img" aria-label="Recorded listing price changes">
      <line x1="20" x2={width - 20} y1="170" y2="170" stroke="#e2e8f0" />
      <polyline points={points} fill="none" stroke="#059669" strokeWidth="3" strokeLinejoin="round" />
      {events.map((event, index) => {
        const [x, y] = points.split(" ")[index].split(",").map(Number);
        return <circle key={`${event.date}-${index}`} cx={x} cy={y} r="4" fill="#059669"><title>{new Date(event.date).toLocaleDateString()}: {formatCents(event.priceCents)} · {event.sellerName}</title></circle>;
      })}
      <text x="20" y="195" fontSize="11" fill="#64748b">{new Date(events[0].date).toLocaleDateString()}</text>
      <text x={width - 20} y="195" textAnchor="end" fontSize="11" fill="#64748b">{new Date(events.at(-1)!.date).toLocaleDateString()}</text>
      <text x="20" y="14" fontSize="11" fill="#64748b">{formatCents(max)}</text>
    </svg>
  );
}

export function AsinReportView({ report, admin }: { report: AsinReport; admin: boolean }) {
  const trafficIssue = report.sellers.find((seller) => seller.trafficError)?.trafficError;
  return (
    <>
      <PageHeader
        title="ASIN performance report"
        subtitle={admin ? "Performance across every Sellfinity seller who mirrored this product." : "Sales and buyer engagement for your listings of this product."}
        actions={<Link href="/analytics" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">← Back to product analytics</Link>}
      />
      <Card className="mb-6 p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          {report.imageUrl && <img src={report.imageUrl} alt="" className="h-24 w-24 rounded-xl border border-slate-200 bg-white object-contain" />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="indigo">{report.asin}</Badge>{report.category && <Badge>{report.category}</Badge>}</div>
            <h2 className="mt-2 text-lg font-semibold text-slate-900">{report.title}</h2>
            {report.amazonUrl && <a href={report.amazonUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-medium text-indigo-600 hover:underline">View Amazon source ↗</a>}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {admin && <StatCard label="Sellers" value={report.sellerCount.toLocaleString()} sub={`${report.activeListings} active listings`} />}
        <StatCard label="Units sold" value={report.unitsSold.toLocaleString()} sub={`${report.orderCount} orders`} />
        <StatCard label="Revenue" value={formatCents(report.revenueCents)} sub={report.averageSalePriceCents ? `${formatCents(report.averageSalePriceCents)} average sale` : "No completed sales"} />
        <StatCard label="Net profit" value={formatCents(report.netProfitCents)} tone={report.netProfitCents >= 0 ? "positive" : "negative"} />
        <StatCard label="Impressions (30d)" value={report.impressions?.toLocaleString() ?? "—"} />
        <StatCard label="Listing views (30d)" value={report.views?.toLocaleString() ?? "—"} />
        <StatCard label="Click-through rate" value={percent(report.clickThroughRate)} />
        <StatCard label="Sales conversion" value={percent(report.salesConversionRate)} />
      </div>
      {trafficIssue && <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{trafficIssue}</p>}

      <Card className="mt-6 p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-slate-900">Sales trend</h2><span className="text-xs text-slate-500">Last 30 days</span></div>
        <SalesChart report={report} />
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4"><h2 className="font-semibold text-slate-900">Price history</h2><p className="mt-1 text-xs text-slate-500">Prices recorded when Sellfinity published or revised a listing.</p></div>
        {report.priceHistory.length ? <><div className="overflow-x-auto p-5"><PriceChart report={report} /></div><div className="max-h-72 overflow-auto border-t border-slate-100"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-5 py-3">Date</th>{admin && <th className="px-5 py-3">Seller</th>}<th className="px-5 py-3">Action</th><th className="px-5 py-3 text-right">Price</th></tr></thead><tbody>{[...report.priceHistory].reverse().map((event, index) => <tr key={`${event.date}-${index}`} className="border-t border-slate-100"><td className="px-5 py-3 whitespace-nowrap">{new Date(event.date).toLocaleString()}</td>{admin && <td className="px-5 py-3">{event.sellerName}</td>}<td className="px-5 py-3 text-slate-500">{event.source.replaceAll("_", " ").toLowerCase()}</td><td className="px-5 py-3 text-right font-medium tabular-nums">{formatCents(event.priceCents)}</td></tr>)}</tbody></table></div></> : <p className="px-5 py-10 text-center text-sm text-slate-500">No recorded price changes yet.</p>}
      </Card>

      {admin && <Card className="mt-6 overflow-x-auto"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-semibold text-slate-900">Seller performance</h2><p className="mt-1 text-xs text-slate-500">Users who mirrored this ASIN and performance from their own listings.</p></div><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-5 py-3">Seller</th><th className="px-5 py-3 text-right">Listings</th><th className="px-5 py-3 text-right">Units</th><th className="px-5 py-3 text-right">Revenue</th><th className="px-5 py-3 text-right">Profit</th><th className="px-5 py-3 text-right">Views</th><th className="px-5 py-3 text-right">Conversion</th></tr></thead><tbody>{report.sellers.map((seller) => <tr key={seller.userId} className="border-t border-slate-100"><td className="px-5 py-4"><p className="font-medium text-slate-900">{seller.name}</p><p className="text-xs text-slate-500">{seller.email}{seller.ebayUsername ? ` · ${seller.ebayUsername}` : ""}</p>{seller.trafficError && <p className="mt-1 max-w-xs text-xs text-amber-700">{seller.trafficError}</p>}</td><td className="px-5 py-4 text-right">{seller.activeListings}/{seller.listingCount} active</td><td className="px-5 py-4 text-right font-medium">{seller.unitsSold}</td><td className="px-5 py-4 text-right">{formatCents(seller.revenueCents)}</td><td className={`px-5 py-4 text-right font-medium ${seller.netProfitCents >= 0 ? "text-emerald-700" : "text-red-600"}`}>{formatCents(seller.netProfitCents)}</td><td className="px-5 py-4 text-right">{seller.views?.toLocaleString() ?? "—"}</td><td className="px-5 py-4 text-right">{percent(seller.salesConversionRate)}</td></tr>)}</tbody></table></Card>}
    </>
  );
}
