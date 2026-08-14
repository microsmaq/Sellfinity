"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Card, EmptyState, Input, StatCard, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { ProductAnalyticsDay, ProductAnalyticsOverview, ProductAnalyticsRow } from "@/lib/analytics/product-overview";

type SortKey = "revenue" | "units" | "profit" | "listings" | "sellers" | "price" | "title" | "activity";

const sortOptions: { value: SortKey; label: string }[] = [
  { value: "revenue", label: "Revenue" },
  { value: "units", label: "Units sold" },
  { value: "profit", label: "Net profit" },
  { value: "listings", label: "Listings" },
  { value: "sellers", label: "Sellers" },
  { value: "price", label: "Average price" },
  { value: "activity", label: "Recent activity" },
  { value: "title", label: "Product name" },
];

function sortValue(row: ProductAnalyticsRow, key: SortKey): number | string {
  switch (key) {
    case "revenue": return row.revenueCents;
    case "units": return row.unitsSold;
    case "profit": return row.netProfitCents;
    case "listings": return row.listingCount;
    case "sellers": return row.sellerCount;
    case "price": return row.averageListingPriceCents ?? -1;
    case "activity": return row.lastActivityAt;
    case "title": return row.title.toLocaleLowerCase();
  }
}

function OverviewChart({ points }: { points: ProductAnalyticsDay[] }) {
  const width = 960;
  const height = 250;
  const top = 22;
  const bottom = 38;
  const chartHeight = height - top - bottom;
  const maxRevenue = Math.max(1, ...points.map((point) => point.revenueCents));
  const maxUnits = Math.max(1, ...points.map((point) => point.units));
  const slot = width / points.length;
  const line = points.map((point, index) => {
    const x = index * slot + slot / 2;
    const y = top + chartHeight - (point.revenueCents / maxRevenue) * chartHeight;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[720px] w-full" role="img" aria-label="Revenue and units sold over the last 30 days">
        {[0, 0.5, 1].map((ratio) => <line key={ratio} x1="0" x2={width} y1={top + chartHeight * ratio} y2={top + chartHeight * ratio} stroke="#e2e8f0" />)}
        {points.map((point, index) => {
          const barHeight = (point.units / maxUnits) * chartHeight;
          return (
            <g key={point.date}>
              <rect x={index * slot + slot * 0.22} y={top + chartHeight - barHeight} width={Math.max(2, slot * 0.56)} height={barHeight} rx="2" fill="#c7d2fe">
                <title>{point.date}: {point.units} units, {formatCents(point.revenueCents)} revenue, {formatCents(point.netProfitCents)} profit</title>
              </rect>
              {(index === 0 || index === points.length - 1 || index % 7 === 0) && <text x={index * slot + slot / 2} y={height - 12} textAnchor="middle" fontSize="11" fill="#64748b">{new Date(`${point.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</text>}
            </g>
          );
        })}
        <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex items-center justify-center gap-5 text-xs text-slate-500">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-indigo-200" /> Units sold</span>
        <span><span className="mr-1 inline-block h-0.5 w-4 align-middle bg-indigo-600" /> Revenue</span>
      </div>
    </div>
  );
}

function TopProducts({ rows }: { rows: ProductAnalyticsRow[] }) {
  const top = [...rows].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 5);
  const max = Math.max(1, ...top.map((row) => row.revenueCents));
  return (
    <div className="space-y-4">
      {top.map((row, index) => (
        <div key={row.asin}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium text-slate-700"><span className="mr-2 text-slate-400">{index + 1}</span>{row.title}</span>
            <span className="shrink-0 font-semibold tabular-nums text-slate-900">{formatCents(row.revenueCents)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(row.revenueCents ? 4 : 0, (row.revenueCents / max) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export function ProductAnalyticsDashboard({ overview, admin }: { overview: ProductAnalyticsOverview; admin: boolean }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [descending, setDescending] = useState(true);
  const categories = useMemo(() => [...new Set(overview.rows.map((row) => row.category).filter((value): value is string => Boolean(value)))].sort(), [overview.rows]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return overview.rows
      .filter((row) => !needle || `${row.title} ${row.asin} ${row.category ?? ""}`.toLocaleLowerCase().includes(needle))
      .filter((row) => category === "ALL" || row.category === category)
      .filter((row) => status === "ALL" || (status === "ACTIVE" ? row.activeListings > 0 : status === "MIRRORED" ? row.sellerCount > 0 : row.sellerCount === 0))
      .sort((a, b) => {
        const left = sortValue(a, sortKey);
        const right = sortValue(b, sortKey);
        const result = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
        return descending ? -result : result;
      });
  }, [category, descending, overview.rows, query, sortKey, status]);

  const changeSort = (key: SortKey) => {
    if (key === sortKey) setDescending((value) => !value);
    else {
      setSortKey(key);
      setDescending(key !== "title");
    }
  };
  const arrow = (key: SortKey) => sortKey === key ? (descending ? " ↓" : " ↑") : "";

  if (overview.rows.length === 0) return <EmptyState title="No products yet" body="Mirror an Amazon product or publish one from the Arbitrage Finder to begin tracking performance." action={!admin && <Link href="/mirror" className="text-sm font-medium text-indigo-600">Mirror a product →</Link>} />;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={admin ? "All products" : "Your products"} value={overview.totals.productCount.toLocaleString()} sub={admin ? `${overview.totals.mirroredProductCount} mirrored by sellers` : `${overview.totals.activeListings} active listings`} />
        {admin && <StatCard label="Sellers" value={overview.totals.sellerCount.toLocaleString()} sub={`${overview.totals.activeListings} active listings`} />}
        <StatCard label="Units sold" value={overview.totals.unitsSold.toLocaleString()} sub="All completed sales" />
        <StatCard label="Revenue" value={formatCents(overview.totals.revenueCents)} sub={`${overview.totals.listingCount} total listings`} />
        <StatCard label="Net profit" value={formatCents(overview.totals.netProfitCents)} tone={overview.totals.netProfitCents >= 0 ? "positive" : "negative"} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <Card className="p-5"><div className="mb-2"><h2 className="font-semibold text-slate-900">Sales performance</h2><p className="text-xs text-slate-500">Revenue and units sold across the last 30 days.</p></div><OverviewChart points={overview.daily} /></Card>
        <Card className="p-5"><div className="mb-5"><h2 className="font-semibold text-slate-900">Top products</h2><p className="text-xs text-slate-500">Highest revenue across the selected account scope.</p></div><TopProducts rows={overview.rows} /></Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-200 p-4 sm:p-5">
          <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-end">
            <div><h2 className="font-semibold text-slate-900">Product performance</h2><p className="mt-1 text-xs text-slate-500">Search by product, ASIN, or category. Click any column heading to sort.</p></div>
            <div className="grid gap-2 sm:grid-cols-2 xl:flex">
              <Input aria-label="Search products" placeholder="Search products or ASINs…" value={query} onChange={(event) => setQuery(event.target.value)} className="xl:w-64" />
              <select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"><option value="ALL">All categories</option>{categories.map((value) => <option key={value}>{value}</option>)}</select>
              <select aria-label="Filter by listing status" value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"><option value="ALL">All products</option><option value="ACTIVE">Active listings</option><option value="MIRRORED">Mirrored products</option>{admin && <option value="UNMIRRORED">Not yet mirrored</option>}</select>
              <div className="flex gap-2 xl:hidden"><select aria-label="Sort products" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700">{sortOptions.map((option) => <option key={option.value} value={option.value}>Sort: {option.label}</option>)}</select><button type="button" onClick={() => setDescending((value) => !value)} className="rounded-lg border border-slate-300 px-3 text-sm text-slate-700" aria-label="Reverse sort">{descending ? "Descending" : "Ascending"}</button></div>
            </div>
          </div>
          <p className="mt-3 text-xs font-medium text-slate-500">Showing {rows.length.toLocaleString()} of {overview.rows.length.toLocaleString()} products</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3"><button onClick={() => changeSort("title")} className="hover:text-indigo-600">Product{arrow("title")}</button></th>
              {admin && <th className="px-4 py-3 text-right"><button onClick={() => changeSort("sellers")} className="hover:text-indigo-600">Sellers{arrow("sellers")}</button></th>}
              <th className="px-4 py-3 text-right"><button onClick={() => changeSort("listings")} className="hover:text-indigo-600">Listings{arrow("listings")}</button></th>
              <th className="px-4 py-3 text-right"><button onClick={() => changeSort("units")} className="hover:text-indigo-600">Units{arrow("units")}</button></th>
              <th className="px-4 py-3 text-right"><button onClick={() => changeSort("revenue")} className="hover:text-indigo-600">Revenue{arrow("revenue")}</button></th>
              <th className="px-4 py-3 text-right"><button onClick={() => changeSort("profit")} className="hover:text-indigo-600">Profit{arrow("profit")}</button></th>
              <th className="px-4 py-3 text-right"><button onClick={() => changeSort("price")} className="hover:text-indigo-600">Avg. price{arrow("price")}</button></th>
            </tr></thead>
            <tbody>{rows.map((row) => {
              const href = admin ? `/admin/arbitrage/${encodeURIComponent(row.asin)}` : `/analytics/asins/${encodeURIComponent(row.asin)}`;
              return <tr key={row.asin} className="border-t border-slate-100 hover:bg-slate-50"><td className="px-5 py-4"><Link href={href} className="group flex items-center gap-3">{row.imageUrl ? <img src={row.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg border border-slate-200 bg-white object-contain" /> : <div className="h-12 w-12 shrink-0 rounded-lg bg-slate-100" />}<span className="min-w-0"><span className="block max-w-md truncate font-medium text-slate-900 group-hover:text-indigo-700">{row.title}</span><span className="mt-0.5 block text-xs text-slate-500">{row.asin}{row.category ? ` · ${row.category}` : ""}</span></span></Link></td>{admin && <td className="px-4 py-4 text-right font-medium">{row.sellerCount}</td>}<td className="px-4 py-4 text-right"><Badge tone={row.activeListings ? "green" : "slate"}>{row.activeListings}/{row.listingCount} active</Badge></td><td className="px-4 py-4 text-right font-medium tabular-nums">{row.unitsSold}</td><td className="px-4 py-4 text-right tabular-nums">{formatCents(row.revenueCents)}</td><td className={cx("px-4 py-4 text-right font-medium tabular-nums", row.netProfitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{formatCents(row.netProfitCents)}</td><td className="px-4 py-4 text-right tabular-nums">{row.averageListingPriceCents === null ? "—" : formatCents(row.averageListingPriceCents)}</td></tr>;
            })}</tbody>
          </table>
          {rows.length === 0 && <p className="px-5 py-12 text-center text-sm text-slate-500">No products match these filters.</p>}
        </div>
      </Card>
    </>
  );
}
