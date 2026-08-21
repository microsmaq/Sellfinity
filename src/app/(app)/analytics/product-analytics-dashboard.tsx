"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Card, EmptyState, Input, StatCard, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type {
  ProductAnalyticsDay,
  ProductAnalyticsOverview,
  ProductAnalyticsRow,
} from "@/lib/analytics/product-overview";

type SortKey =
  | "revenue"
  | "units"
  | "profit"
  | "listings"
  | "sellers"
  | "price"
  | "views"
  | "impressions"
  | "ctr"
  | "suggested"
  | "competitor"
  | "position"
  | "title"
  | "activity";
const sortOptions: { value: SortKey; label: string }[] = [
  ["revenue", "Revenue"],
  ["units", "Units sold"],
  ["profit", "Net profit"],
  ["views", "Listing clicks"],
  ["impressions", "Impressions"],
  ["ctr", "Click-through rate"],
  ["listings", "Listings"],
  ["sellers", "Sellers"],
  ["price", "Current price"],
  ["suggested", "Suggested price"],
  ["competitor", "Competitor average"],
  ["position", "Price position"],
  ["activity", "Recent activity"],
  ["title", "Product name"],
].map(([value, label]) => ({ value: value as SortKey, label }));

function percent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2).replace(/\.00$/, "")}%`;
}
function sortValue(row: ProductAnalyticsRow, key: SortKey): number | string {
  const values: Record<Exclude<SortKey, "title" | "activity" | "position">, number> = {
    revenue: row.revenueCents,
    units: row.unitsSold,
    profit: row.netProfitCents,
    listings: row.listingCount,
    sellers: row.sellerCount,
    price: row.averageListingPriceCents ?? -1,
    views: row.views ?? -1,
    impressions: row.impressions ?? -1,
    ctr: row.clickThroughRate ?? -1,
    suggested: row.suggestedPriceCents ?? -1,
    competitor: row.averageCompetitorPriceCents ?? -1,
  };
  return key === "title"
    ? row.title.toLocaleLowerCase()
    : key === "activity"
      ? row.lastActivityAt
      : key === "position"
        ? row.priceAssessment.label
        : values[key];
}

function TrendChart({
  points,
  traffic = false,
}: {
  points: ProductAnalyticsDay[] | ProductAnalyticsOverview["trafficDaily"];
  traffic?: boolean;
}) {
  const width = 960,
    height = 250,
    top = 22,
    bottom = 38,
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
        aria-label={
          traffic
            ? "Daily impressions and listing clicks"
            : "Daily revenue and units sold"
        }
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
            className={cx(
              "mr-1 inline-block h-2.5 w-2.5 rounded-sm",
              traffic ? "bg-sky-200" : "bg-indigo-200",
            )}
          />
          {traffic ? "Impressions" : "Revenue"}
        </span>
        <span>
          <span
            className={cx(
              "mr-1 inline-block h-0.5 w-4 align-middle",
              traffic ? "bg-sky-600" : "bg-indigo-600",
            )}
          />
          {traffic ? "Clicks / listing views" : "Units sold"}
        </span>
      </div>
    </div>
  );
}

function TopProducts({ rows }: { rows: ProductAnalyticsRow[] }) {
  const top = [...rows]
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .slice(0, 5),
    max = Math.max(1, ...rows.map((row) => row.revenueCents));
  return (
    <div className="space-y-4">
      {top.map((row, index) => (
        <div key={row.asin}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-slate-700">
              <span className="mr-2 text-slate-400">{index + 1}</span>
              {row.title}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">
              {formatCents(row.revenueCents)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{
                width: `${Math.max(row.revenueCents ? 4 : 0, (row.revenueCents / max) * 100)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProductAnalyticsDashboard({
  overview,
  admin,
  startDate,
  endDate,
}: {
  overview: ProductAnalyticsOverview;
  admin: boolean;
  startDate: string;
  endDate: string;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("ALL"),
    [status, setStatus] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("revenue"),
    [descending, setDescending] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const categories = useMemo(
    () =>
      [
        ...new Set(
          overview.rows
            .map((row) => row.category)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort(),
    [overview.rows],
  );
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return overview.rows
      .filter(
        (row) =>
          !needle ||
          `${row.title} ${row.asin} ${row.category ?? ""}`
            .toLocaleLowerCase()
            .includes(needle),
      )
      .filter((row) => category === "ALL" || row.category === category)
      .filter(
        (row) =>
          status === "ALL" ||
          (status === "ACTIVE"
            ? row.activeListings > 0
            : status === "MIRRORED"
              ? row.sellerCount > 0
              : row.sellerCount === 0),
      )
      .sort((a, b) => {
        const left = sortValue(a, sortKey),
          right = sortValue(b, sortKey);
        const result =
          typeof left === "string" && typeof right === "string"
            ? left.localeCompare(right)
            : Number(left) - Number(right);
        return descending ? -result : result;
      });
  }, [category, descending, overview.rows, query, sortKey, status]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const firstRow = rows.length ? (currentPage - 1) * pageSize + 1 : 0;
  const lastRow = Math.min(currentPage * pageSize, rows.length);
  const visibleRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const changeSort = (key: SortKey) => {
    setPage(1);
    if (key === sortKey) setDescending((value) => !value);
    else {
      setSortKey(key);
      setDescending(key !== "title");
    }
  };
  const arrow = (key: SortKey) =>
    sortKey === key ? (descending ? " ↓" : " ↑") : "";
  if (!overview.rows.length)
    return (
      <EmptyState
        title="No products yet"
        body="Mirror an Amazon product or publish one from the Arbitrage Finder to begin tracking performance."
        action={
          !admin && (
            <Link
              href="/mirror"
              className="text-sm font-medium text-indigo-600"
            >
              Mirror a product →
            </Link>
          )
        }
      />
    );
  return (
    <div className="w-full space-y-6 md:relative md:left-1/2 md:w-[calc(100vw-17rem)] md:-translate-x-1/2">
      <Card className="p-4">
        <form action="/analytics" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Analytics date range</p>
            <p className="mt-0.5 text-xs text-slate-500">Sales, profit, and traffic metrics update for the selected period, up to 90 days.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-end">
            <label className="text-xs font-medium text-slate-600">From
              <input type="date" name="from" defaultValue={startDate} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
            </label>
            <label className="text-xs font-medium text-slate-600">To
              <input type="date" name="to" defaultValue={endDate} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
            </label>
            <button type="submit" className="col-span-2 min-h-10 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 sm:col-span-1">Apply dates</button>
          </div>
        </form>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={admin ? "All products" : "Your products"}
          value={overview.totals.productCount.toLocaleString()}
          sub={
            admin
              ? `${overview.totals.mirroredProductCount} mirrored by sellers`
              : `${overview.totals.activeListings} active listings`
          }
        />
        {admin && (
          <StatCard
            label="Sellers"
            value={overview.totals.sellerCount.toLocaleString()}
            sub={`${overview.totals.activeListings} active listings`}
          />
        )}
        <StatCard
          label="Units sold"
          value={overview.totals.unitsSold.toLocaleString()}
          sub="All completed sales"
        />
        <StatCard
          label="Revenue"
          value={formatCents(overview.totals.revenueCents)}
          sub={`${overview.totals.listingCount} total listings`}
        />
        <StatCard
          label="Net profit"
          value={formatCents(overview.totals.netProfitCents)}
          tone={overview.totals.netProfitCents >= 0 ? "positive" : "negative"}
        />
        {!admin && (
          <>
            <StatCard
              label="Impressions"
              value={overview.totals.impressions?.toLocaleString() ?? "—"}
              sub="Across published listings"
            />
            <StatCard
              label="Listing clicks"
              value={overview.totals.views?.toLocaleString() ?? "—"}
              sub={`${percent(overview.totals.clickThroughRate)} click-through rate`}
            />
            <StatCard
              label="Sales conversion"
              value={percent(overview.totals.salesConversionRate)}
              sub="Sales from listing views"
            />
          </>
        )}
      </div>
      {!admin && overview.trafficError && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {overview.trafficError}
        </p>
      )}
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-2">
            <h2 className="font-semibold text-slate-900">Sales performance</h2>
            <p className="text-xs text-slate-500">
              Revenue and units sold from {startDate} through {endDate}.
            </p>
          </div>
          <TrendChart points={overview.daily} />
        </Card>
        {!admin ? (
          <Card className="p-5">
            <div className="mb-2">
              <h2 className="font-semibold text-slate-900">
                Traffic performance
              </h2>
              <p className="text-xs text-slate-500">
                Daily visibility and clicks from {startDate} through {endDate}.
              </p>
            </div>
            <TrendChart points={overview.trafficDaily} traffic />
          </Card>
        ) : (
          <Card className="p-5">
            <div className="mb-5">
              <h2 className="font-semibold text-slate-900">Top products</h2>
            </div>
            <TopProducts rows={overview.rows} />
          </Card>
        )}
      </div>
      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-end">
            <div>
              <h2 className="font-semibold text-slate-900">
                Product performance
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Search any product or ASIN, then sort by sales, traffic, or
                pricing.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:flex">
              <Input
                aria-label="Search products"
                placeholder="Search products or ASINs…"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setPage(1); }}
                className="xl:w-64"
              />
              <select
                aria-label="Filter by category"
                value={category}
                onChange={(event) => { setCategory(event.target.value); setPage(1); }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="ALL">All categories</option>
                {categories.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <select
                aria-label="Filter by listing status"
                value={status}
                onChange={(event) => { setStatus(event.target.value); setPage(1); }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="ALL">All products</option>
                <option value="ACTIVE">Active listings</option>
                <option value="MIRRORED">Mirrored products</option>
                {admin && <option value="UNMIRRORED">Not yet mirrored</option>}
              </select>
              <div className="flex gap-2 xl:hidden">
                <select
                  aria-label="Sort products"
                  value={sortKey}
                  onChange={(event) =>
                    { setSortKey(event.target.value as SortKey); setPage(1); }
                  }
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {sortOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      Sort: {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { setDescending((value) => !value); setPage(1); }}
                  className="rounded-lg border border-slate-300 px-3 text-sm"
                >
                  {descending ? "Descending" : "Ascending"}
                </button>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs font-medium text-slate-500">
            Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {rows.length.toLocaleString()} filtered ·{" "}
            {overview.rows.length.toLocaleString()} products
          </p>
        </div>
        <div className="space-y-3 bg-slate-50/60 p-3 md:hidden">
          {visibleRows.map((row) => (
            <Link key={row.asin} href={`/analytics/asins/${encodeURIComponent(row.asin)}`} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm active:scale-[.99]">
              <div className="flex items-start gap-3">
                {row.imageUrl ? <img src={row.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl border object-contain" /> : <div className="h-14 w-14 shrink-0 rounded-xl bg-slate-100" />}
                <div className="min-w-0 flex-1"><p className="line-clamp-2 text-[13px] font-semibold leading-5 text-slate-950">{row.title}</p><p className="mt-1 text-xs text-slate-500">{row.asin} · {row.activeListings}/{row.listingCount} active</p><div className="mt-2 flex flex-wrap gap-1.5"><Badge tone={row.priceAssessment.tone}>{row.priceAssessment.label}</Badge>{row.verifiedWinner ? <Badge tone="green">🏆 Verified winner</Badge> : null}</div></div>
              </div>
              <div className="mt-3 grid grid-cols-3 rounded-xl bg-slate-50 p-3 text-center"><div><p className="text-[10px] uppercase text-slate-400">Revenue</p><p className="mt-1 truncate text-sm font-bold">{formatCents(row.revenueCents)}</p></div><div className="border-x border-slate-200"><p className="text-[10px] uppercase text-slate-400">Clicks</p><p className="mt-1 text-sm font-bold">{row.views?.toLocaleString() ?? "—"}</p></div><div><p className="text-[10px] uppercase text-slate-400">CTR</p><p className="mt-1 text-sm font-bold">{percent(row.clickThroughRate)}</p></div></div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs"><span className="text-slate-500">Price {row.averageListingPriceCents === null ? "—" : formatCents(row.averageListingPriceCents)}</span><span className="font-semibold text-indigo-700">Suggested {row.suggestedPriceCents === null ? "—" : formatCents(row.suggestedPriceCents)}</span></div>
            </Link>
          ))}
          {!rows.length && <p className="p-8 text-center text-sm text-slate-500">No products match these filters.</p>}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1420px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">
                  <button onClick={() => changeSort("title")}>
                    Product{arrow("title")}
                  </button>
                </th>
                {admin && (
                  <th className="px-4 py-3 text-right">
                    <button onClick={() => changeSort("sellers")}>
                      Sellers{arrow("sellers")}
                    </button>
                  </th>
                )}
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("listings")}>
                    Listings{arrow("listings")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("units")}>
                    Units{arrow("units")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("revenue")}>
                    Revenue{arrow("revenue")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("profit")}>
                    Profit{arrow("profit")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("impressions")}>
                    Impressions{arrow("impressions")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("views")}>
                    Clicks{arrow("views")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("ctr")}>
                    CTR{arrow("ctr")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("price")}>
                    Your price{arrow("price")}
                  </button>
                </th>
                <th className="px-4 py-3 text-right"><button onClick={() => changeSort("competitor")}>Competitor avg.{arrow("competitor")}</button></th>
                <th className="px-4 py-3 text-right">
                  <button onClick={() => changeSort("suggested")}>
                    Suggested{arrow("suggested")}
                  </button>
                </th>
                <th className="px-4 py-3"><button onClick={() => changeSort("position")}>Price position{arrow("position")}</button></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const href = `/analytics/asins/${encodeURIComponent(row.asin)}`;
                return (
                  <tr
                    key={row.asin}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <Link
                        href={href}
                        className="group flex items-center gap-3"
                      >
                        {row.imageUrl ? (
                          <img
                            src={row.imageUrl}
                            alt=""
                            className="h-12 w-12 shrink-0 rounded-lg border object-contain"
                          />
                        ) : (
                          <div className="h-12 w-12 shrink-0 rounded-lg bg-slate-100" />
                        )}
                        <span className="min-w-0">
                          <span className="block max-w-md truncate font-medium group-hover:text-indigo-700">
                            {row.title}
                          </span>
                          <span className="text-xs text-slate-500">
                            {row.asin}
                            {row.category ? ` · ${row.category}` : ""}
                          </span>
                        </span>
                      </Link>
                    </td>
                    {admin && (
                      <td className="px-4 py-4 text-right">
                        {row.sellerCount}
                      </td>
                    )}
                    <td className="px-4 py-4 text-right">
                      <Badge tone={row.activeListings ? "green" : "slate"}>
                        {row.activeListings}/{row.listingCount} active
                      </Badge>
                      {row.verifiedWinner ? <Badge tone="green">🏆 Verified winner · price locked</Badge> : null}
                    </td>
                    <td className="px-4 py-4 text-right">{row.unitsSold}</td>
                    <td className="px-4 py-4 text-right">
                      {formatCents(row.revenueCents)}
                    </td>
                    <td
                      className={cx(
                        "px-4 py-4 text-right font-medium",
                        row.netProfitCents >= 0
                          ? "text-emerald-700"
                          : "text-red-600",
                      )}
                    >
                      {formatCents(row.netProfitCents)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {row.impressions?.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {row.views?.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {percent(row.clickThroughRate)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {row.averageListingPriceCents === null
                        ? "—"
                        : formatCents(row.averageListingPriceCents)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {row.averageCompetitorPriceCents === null
                        ? "—"
                        : formatCents(row.averageCompetitorPriceCents)}
                    </td>
                    <td className="px-4 py-4 text-right font-medium text-indigo-700">
                      {row.suggestedPriceCents === null
                        ? "—"
                        : formatCents(row.suggestedPriceCents)}
                    </td>
                    <td className="px-4 py-4">
                      <Badge tone={row.priceAssessment.tone}>
                        {row.priceAssessment.label}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && (
            <p className="px-5 py-12 text-center text-sm text-slate-500">
              No products match these filters.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span>Rows per page</span>
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
            <span>{firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {rows.length.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <button type="button" disabled={currentPage === 1} onClick={() => setPage(1)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40">First</button>
            <button type="button" disabled={currentPage === 1} onClick={() => setPage(Math.max(1, currentPage - 1))} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40">Previous</button>
            <span className="min-w-20 text-center text-xs font-semibold text-slate-700">Page {currentPage} of {pageCount}</span>
            <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(Math.min(pageCount, currentPage + 1))} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40">Next</button>
            <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(pageCount)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40">Last</button>
          </div>
        </div>
      </Card>
    </div>
  );
}
