/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { Badge, Card, PageHeader, StatCard } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { AsinReport } from "@/lib/analytics/asin-report";

function percent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2).replace(/\.00$/, "")}%`;
}
function metric(value: number | null) {
  return value === null ? "—" : value.toLocaleString();
}

function DualChart({
  points,
  traffic = false,
}: {
  points: AsinReport["daily"] | AsinReport["trafficDaily"];
  traffic?: boolean;
}) {
  const width = 900,
    height = 260,
    top = 20,
    bottom = 36,
    chartHeight = height - top - bottom;
  const primary = points.map((point) =>
    traffic
      ? "impressions" in point
        ? point.impressions
        : 0
      : "revenueCents" in point
        ? point.revenueCents
        : 0,
  );
  const secondary = points.map((point) =>
    traffic
      ? "views" in point
        ? point.views
        : 0
      : "units" in point
        ? point.units
        : 0,
  );
  const maxPrimary = Math.max(1, ...primary),
    maxSecondary = Math.max(1, ...secondary),
    slot = width / Math.max(points.length, 1);
  const line = secondary
    .map(
      (value, index) =>
        `${index * slot + slot / 2},${top + chartHeight - (value / maxSecondary) * chartHeight}`,
    )
    .join(" ");
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={traffic ? "Traffic history" : "Sales history"}
      >
        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2={width}
            y1={top + chartHeight * ratio}
            y2={top + chartHeight * ratio}
            stroke="#e2e8f0"
          />
        ))}
        {points.map((point, index) => {
          const barHeight = (primary[index] / maxPrimary) * chartHeight;
          return (
            <g key={point.date}>
              <rect
                x={index * slot + slot * 0.2}
                y={top + chartHeight - barHeight}
                width={Math.max(2, slot * 0.6)}
                height={barHeight}
                rx="2"
                fill={traffic ? "#bae6fd" : "#c7d2fe"}
              >
                <title>
                  {point.date}: {primary[index].toLocaleString()}{" "}
                  {traffic ? "impressions" : "revenue cents"},{" "}
                  {secondary[index].toLocaleString()}{" "}
                  {traffic ? "clicks/views" : "units"}
                </title>
              </rect>
              {(index === 0 ||
                index === points.length - 1 ||
                index % 7 === 0) && (
                <text
                  x={index * slot + slot / 2}
                  y={height - 12}
                  textAnchor="middle"
                  fontSize="11"
                  fill="#64748b"
                >
                  {new Date(`${point.date}T00:00:00Z`).toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric", timeZone: "UTC" },
                  )}
                </text>
              )}
            </g>
          );
        })}
        <polyline
          points={line}
          fill="none"
          stroke={traffic ? "#0284c7" : "#4f46e5"}
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="flex items-center justify-center gap-5 text-xs text-slate-500">
        <span>
          <span
            className={`mr-1 inline-block h-2.5 w-2.5 rounded-sm ${traffic ? "bg-sky-200" : "bg-indigo-200"}`}
          />
          {traffic ? "Impressions" : "Revenue"}
        </span>
        <span>
          <span
            className={`mr-1 inline-block h-0.5 w-4 align-middle ${traffic ? "bg-sky-600" : "bg-indigo-600"}`}
          />
          {traffic ? "Clicks / listing views" : "Units sold"}
        </span>
      </div>
    </div>
  );
}

function PriceChart({ report }: { report: AsinReport }) {
  const items = [
    {
      label: "Your average",
      value: report.currentAverageListingPriceCents,
      color: "bg-indigo-600",
    },
    {
      label: "Competitor average",
      value: report.averageCompetitorPriceCents,
      color: "bg-slate-500",
    },
    {
      label: "Best-selling price",
      value: report.bestSellingPriceCents,
      color: "bg-sky-500",
    },
    {
      label: "Suggested price",
      value: report.suggestedPriceCents,
      color: "bg-emerald-500",
    },
  ];
  const max = Math.max(1, ...items.map((item) => item.value ?? 0));
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div key={item.label}>
          <div className="mb-1.5 flex justify-between text-sm">
            <span className="text-slate-600">{item.label}</span>
            <span className="font-semibold tabular-nums">
              {item.value === null ? "—" : formatCents(item.value)}
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${item.color}`}
              style={{
                width: `${item.value ? Math.max(4, (item.value / max) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function PriceHistory({ events }: { events: AsinReport["priceHistory"] }) {
  if (!events.length) return <p className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">Price history will appear after the first listing price is recorded.</p>;
  const points = events.slice(-60);
  const width = 1000, height = 230, top = 24, bottom = 38, chartHeight = height - top - bottom;
  const prices = points.map((event) => event.priceCents);
  const min = Math.min(...prices), max = Math.max(...prices), range = Math.max(1, max - min);
  const x = (index: number) => points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
  const y = (price: number) => top + chartHeight - ((price - min) / range) * chartHeight;
  const line = points.map((event, index) => `${x(index)},${y(event.priceCents)}`).join(" ");
  const sourceLabel = (source: string) => source.toLocaleLowerCase().replaceAll("_", " ");
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/50 p-3">
        <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[720px] w-full" role="img" aria-label="Listing price history">
          {[0, 0.5, 1].map((ratio) => <line key={ratio} x1="0" x2={width} y1={top + chartHeight * ratio} y2={top + chartHeight * ratio} stroke="#e2e8f0" />)}
          <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
          {points.map((event, index) => <circle key={`${event.date}-${index}`} cx={x(index)} cy={y(event.priceCents)} r="5" fill="#4f46e5"><title>{new Date(event.date).toLocaleDateString("en-US")}: {formatCents(event.priceCents)} · {event.sellerName} · {sourceLabel(event.source)}</title></circle>)}
          <text x="0" y={height - 10} fontSize="12" fill="#64748b">{new Date(points[0].date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</text>
          <text x={width} y={height - 10} textAnchor="end" fontSize="12" fill="#64748b">{new Date(points.at(-1)!.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</text>
          <text x="8" y={top + 12} fontSize="12" fill="#475569">{formatCents(max)}</text>
          <text x="8" y={top + chartHeight - 8} fontSize="12" fill="#475569">{formatCents(min)}</text>
        </svg>
      </div>
      <div className="space-y-2">
        {[...events].reverse().slice(0, 8).map((event, index) => (
          <div key={`${event.date}-${event.sellerName}-${index}`} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
            <div className="min-w-0"><p className="truncate text-xs font-medium text-slate-800">{event.sellerName}</p><p className="mt-0.5 text-[11px] capitalize text-slate-500">{sourceLabel(event.source)} · {new Date(event.date).toLocaleDateString("en-US")}</p></div>
            <p className="shrink-0 text-sm font-bold tabular-nums text-indigo-700">{formatCents(event.priceCents)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AsinReportView({
  report,
  admin,
}: {
  report: AsinReport;
  admin: boolean;
}) {
  const trafficIssue = report.sellers.find(
    (seller) => seller.trafficError,
  )?.trafficError;
  return (
    <>
      <PageHeader
        title="ASIN performance report"
        subtitle={
          admin
            ? "Performance across every Sellfinity seller who mirrored this product."
            : "Sales, traffic, pricing, and growth guidance for your listings."
        }
        actions={
          <Link
            href="/analytics"
            className="text-sm font-medium text-indigo-600"
          >
            ← Back to product analytics
          </Link>
        }
      />
      <Card className="mb-6 p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          {report.imageUrl && (
            <img
              src={report.imageUrl}
              alt=""
              className="h-24 w-24 rounded-xl border bg-white object-contain"
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <Badge tone="indigo">{report.asin}</Badge>
              {report.category && <Badge>{report.category}</Badge>}
              <Badge tone={report.priceAssessment.tone}>
                {report.priceAssessment.label}
              </Badge>
            </div>
            <h2 className="mt-2 text-lg font-semibold text-slate-900">
              {report.title}
            </h2>
            {report.amazonUrl && (
              <a
                href={report.amazonUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-sm font-medium text-indigo-600"
              >
                View Amazon source ↗
              </a>
            )}
          </div>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {admin && (
          <StatCard
            label="Sellers"
            value={report.sellerCount.toLocaleString()}
            sub={`${report.activeListings} active listings`}
          />
        )}
        <StatCard
          label="Units sold"
          value={report.unitsSold.toLocaleString()}
          sub={`${report.orderCount} orders`}
        />
        <StatCard
          label="Revenue"
          value={formatCents(report.revenueCents)}
          sub={
            report.averageSalePriceCents
              ? `${formatCents(report.averageSalePriceCents)} average sale`
              : "No completed sales"
          }
        />
        <StatCard
          label="Net profit"
          value={formatCents(report.netProfitCents)}
          tone={report.netProfitCents >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="Impressions (30d)"
          value={metric(report.impressions)}
        />
        <StatCard
          label="Listing clicks (30d)"
          value={metric(report.views)}
          sub="eBay listing views"
        />
        <StatCard
          label="Click-through rate"
          value={percent(report.clickThroughRate)}
        />
        <StatCard
          label="Sales conversion"
          value={percent(report.salesConversionRate)}
        />
      </div>
      {trafficIssue && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {trafficIssue}
        </p>
      )}
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3">
            <h2 className="font-semibold">Traffic trend</h2>
            <p className="text-xs text-slate-500">
              Daily impressions and clicks/views for the last 30 days.
            </p>
          </div>
          <DualChart points={report.trafficDaily} traffic />
        </Card>
        <Card className="p-5">
          <div className="mb-3">
            <h2 className="font-semibold">Sales trend</h2>
            <p className="text-xs text-slate-500">
              Daily revenue and units for the last 30 days.
            </p>
          </div>
          <DualChart points={report.daily} />
        </Card>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Pricing competitiveness</h2>
              <p className="mt-1 text-xs text-slate-500">
                Your price compared with researched eBay market benchmarks.
              </p>
            </div>
            <Badge tone={report.priceAssessment.tone}>
              {report.priceAssessment.label}
            </Badge>
          </div>
          <PriceChart report={report} />
          <p className="mt-5 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            {report.priceAssessment.summary}
          </p>
          {report.competitorCount !== null && (
            <p className="mt-2 text-xs text-slate-500">
              Based on {report.competitorCount.toLocaleString()} competing
              listings.
            </p>
          )}
        </Card>
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Sellfinity AI assessment</h2>
              <p className="mt-1 text-sm text-slate-600">
                {report.growthAssessment.summary}
              </p>
            </div>
            <div className="shrink-0 rounded-2xl bg-indigo-50 px-4 py-3 text-center">
              <p className="text-2xl font-bold text-indigo-700">
                {report.growthAssessment.score}
              </p>
              <p className="text-[10px] font-semibold uppercase text-indigo-600">
                {report.growthAssessment.label}
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {report.growthAssessment.suggestions.map((suggestion) => (
              <div
                key={`${suggestion.area}-${suggestion.title}`}
                className="rounded-xl border border-slate-200 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      suggestion.priority === "High"
                        ? "red"
                        : suggestion.priority === "Medium"
                          ? "amber"
                          : "green"
                    }
                  >
                    {suggestion.priority}
                  </Badge>
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {suggestion.area}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {suggestion.title}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {suggestion.detail}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card className="mt-6 p-5">
        <div className="mb-4">
          <h2 className="font-semibold">Price history</h2>
          <p className="mt-1 text-xs text-slate-500">Recorded listing prices and price changes for this ASIN. Hover a point for the seller, date, and update source.</p>
        </div>
        <PriceHistory events={report.priceHistory} />
      </Card>
      <Card className="mt-6 overflow-hidden">
        <div className="border-b px-5 py-4">
          <h2 className="font-semibold">Listing-level performance</h2>
          <p className="mt-1 text-xs text-slate-500">
            See exactly which listing needs traffic, conversion, or pricing
            work.
          </p>
        </div>
        <div className="divide-y divide-slate-100 md:hidden">
          {report.listings.map((listing) => (
            <article key={listing.id} className="p-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="line-clamp-2 text-[13px] font-semibold leading-5">{listing.title}</p><p className="mt-1 text-xs text-slate-500">{listing.ebayListingId ?? "Draft"} · {listing.status.toLowerCase()}</p></div><Badge tone={listing.priceAssessment.tone}>{listing.priceAssessment.label}</Badge></div>
              <div className="mt-3 grid grid-cols-4 rounded-xl bg-slate-50 p-3 text-center"><div><p className="text-[9px] uppercase text-slate-400">Views</p><p className="mt-1 text-xs font-bold">{metric(listing.views)}</p></div><div className="border-l border-slate-200"><p className="text-[9px] uppercase text-slate-400">CTR</p><p className="mt-1 text-xs font-bold">{percent(listing.clickThroughRate)}</p></div><div className="border-l border-slate-200"><p className="text-[9px] uppercase text-slate-400">Price</p><p className="mt-1 text-xs font-bold">{formatCents(listing.currentPriceCents)}</p></div><div className="border-l border-slate-200"><p className="text-[9px] uppercase text-slate-400">Suggested</p><p className="mt-1 text-xs font-bold text-indigo-700">{listing.suggestedPriceCents === null ? "—" : formatCents(listing.suggestedPriceCents)}</p></div></div>
            </article>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">Listing</th>
                <th className="px-4 py-3 text-right">Impressions</th>
                <th className="px-4 py-3 text-right">Clicks</th>
                <th className="px-4 py-3 text-right">CTR</th>
                <th className="px-4 py-3 text-right">Conversion</th>
                <th className="px-4 py-3 text-right">Your price</th>
                <th className="px-4 py-3 text-right">Competitor avg.</th>
                <th className="px-4 py-3 text-right">Suggested</th>
                <th className="px-4 py-3">Position</th>
              </tr>
            </thead>
            <tbody>
              {report.listings.map((listing) => (
                <tr key={listing.id} className="border-t">
                  <td className="px-5 py-4">
                    <p className="max-w-sm truncate font-medium">
                      {listing.title}
                    </p>
                    <p className="text-xs text-slate-500">
                      {listing.ebayListingId ?? "Draft"} ·{" "}
                      {listing.status.toLowerCase()}
                    </p>
                  </td>
                  <td className="px-4 py-4 text-right">
                    {metric(listing.impressions)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {metric(listing.views)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {percent(listing.clickThroughRate)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {percent(listing.salesConversionRate)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {formatCents(listing.currentPriceCents)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {listing.averageCompetitorPriceCents === null
                      ? "—"
                      : formatCents(listing.averageCompetitorPriceCents)}
                  </td>
                  <td className="px-4 py-4 text-right font-medium text-indigo-700">
                    {listing.suggestedPriceCents === null
                      ? "—"
                      : formatCents(listing.suggestedPriceCents)}
                  </td>
                  <td className="px-4 py-4">
                    <Badge tone={listing.priceAssessment.tone}>
                      {listing.priceAssessment.label}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!report.listings.length && (
            <p className="p-10 text-center text-sm text-slate-500">
              No listings yet.
            </p>
          )}
        </div>
      </Card>
      {admin && (
        <Card className="mt-6 overflow-x-auto">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold">Seller performance</h2>
            <p className="mt-1 text-xs text-slate-500">
              Users who mirrored this ASIN and performance from their own
              listings.
            </p>
          </div>
          <table className="w-full min-w-[850px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">Seller</th>
                <th className="px-5 py-3 text-right">Listings</th>
                <th className="px-5 py-3 text-right">Units</th>
                <th className="px-5 py-3 text-right">Revenue</th>
                <th className="px-5 py-3 text-right">Profit</th>
                <th className="px-5 py-3 text-right">Clicks</th>
                <th className="px-5 py-3 text-right">Conversion</th>
              </tr>
            </thead>
            <tbody>
              {report.sellers.map((seller) => (
                <tr key={seller.userId} className="border-t">
                  <td className="px-5 py-4">
                    <p className="font-medium">{seller.name}</p>
                    <p className="text-xs text-slate-500">
                      {seller.email}
                      {seller.ebayUsername ? ` · ${seller.ebayUsername}` : ""}
                    </p>
                    {seller.trafficError && (
                      <p className="mt-1 text-xs text-amber-700">
                        {seller.trafficError}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right">
                    {seller.activeListings}/{seller.listingCount} active
                  </td>
                  <td className="px-5 py-4 text-right">{seller.unitsSold}</td>
                  <td className="px-5 py-4 text-right">
                    {formatCents(seller.revenueCents)}
                  </td>
                  <td
                    className={`px-5 py-4 text-right font-medium ${seller.netProfitCents >= 0 ? "text-emerald-700" : "text-red-600"}`}
                  >
                    {formatCents(seller.netProfitCents)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    {metric(seller.views)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    {percent(seller.salesConversionRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
