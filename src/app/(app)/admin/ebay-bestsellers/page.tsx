import Link from "next/link";
import Image from "next/image";
import { requireAdmin } from "@/lib/auth";
import {
  listAdminBestSellers,
  type BestSellerSort,
} from "@/lib/ebay/admin-bestsellers";
import { Badge, Card, PageHeader, StatCard } from "@/components/ui";
import { BestSellerRefreshForm } from "./refresh-form";
import { ebayBestSellerCategory } from "@/lib/ebay/bestseller-categories";

export const metadata = { title: "eBay bestsellers — Sellfinity" };
export const maxDuration = 120;

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export default async function EbayBestSellersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const snapshotKey = typeof params.snapshot === "string" ? params.snapshot : undefined;
  const allowedSorts: BestSellerSort[] = ["sales", "weekSales", "monthSales", "price", "title", "seller", "position"];
  const requestedSort = typeof params.sort === "string" ? params.sort : "sales";
  const sort = allowedSorts.includes(requestedSort as BestSellerSort) ? requestedSort as BestSellerSort : "sales";
  const descending = params.dir !== "asc";
  const pageSize = [25, 50, 100].includes(Number(params.pageSize)) ? Number(params.pageSize) : 50;
  const data = await listAdminBestSellers({
    snapshotKey,
    query,
    sort,
    descending,
    page: Math.max(1, Number(params.page ?? 1) || 1),
    pageSize,
  });
  const href = (changes: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    if (snapshotKey) next.set("snapshot", snapshotKey);
    next.set("sort", sort);
    next.set("dir", descending ? "desc" : "asc");
    next.set("pageSize", String(pageSize));
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    return `/admin/ebay-bestsellers?${next}`;
  };
  const sortHref = (key: BestSellerSort) => href({ sort: key, dir: sort === key && descending ? "asc" : "desc", page: 1 });
  const captured = data.snapshot ? new Date(data.snapshot.capturedAt) : null;
  const categorySearchTerm = data.snapshot?.categoryId
    ? ebayBestSellerCategory(data.snapshot.categoryId).searchTerm
    : "";

  return <div className="space-y-5">
    <PageHeader
      title="eBay bestsellers"
      subtitle="Admin-only proven-demand research using the selected official eBay category. An optional keyword narrows that category. Only listings with a positive quantity sold are saved locally."
      actions={<BestSellerRefreshForm defaultTerm={data.snapshot?.researchTerm ?? "electronics"} defaultCategoryId={data.snapshot?.categoryId} />}
    />

    {data.snapshot ? <>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <StatCard label="Proven sellers" value={data.totalRows.toLocaleString()} sub={data.allResults ? `${data.combinedSnapshots.toLocaleString()} saved research snapshots combined` : `${(data.snapshot.sampledListings ?? data.snapshot.items.length).toLocaleString()} listings sampled`} tone="positive" />
        <StatCard label="Sales · 7 days" value={data.productsWithSales7d ? data.totalSales7d.toLocaleString() : "—"} sub={data.productsWithSales7d ? `${data.productsWithSales7d.toLocaleString()} products with history` : "Collecting weekly history"} tone="positive" />
        <StatCard label="Sales · 30 days" value={data.productsWithSales30d ? data.totalSales30d.toLocaleString() : "—"} sub={data.productsWithSales30d ? `${data.productsWithSales30d.toLocaleString()} products with history` : "Collecting monthly history"} tone="positive" />
        <StatCard label="Lifetime sales" value={data.totalReportedSales.toLocaleString()} sub="Current cumulative sold counts" tone="positive" />
        <StatCard label="Average landed price" value={money(data.averagePriceCents)} sub="Item price plus buyer shipping" />
        <StatCard label="Data provider" value={data.allResults ? "Stored data" : data.snapshot.provider === "EBAY_BROWSE" ? "eBay" : "Countdown"} sub={data.allResults ? "Newest version of every unique item · 0 API calls" : data.snapshot.provider === "EBAY_BROWSE" ? `Official ${data.snapshot.providerDetailMode === "INDIVIDUAL" ? "limited-detail" : "batch"} fallback · 0 Countdown credits` : `${data.snapshot.creditsUsed ?? "—"} credits used · ${data.snapshot.creditsRemaining ?? "—"} remaining`} />
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-4 sm:px-5">
          <form action="/admin/ebay-bestsellers" method="get" className="grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_minmax(15rem,.65fr)_auto_auto]">
            <input name="q" defaultValue={query} placeholder="Search title, item ID, seller, or condition" className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15" />
            <select name="snapshot" defaultValue={snapshotKey ?? ""} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-500">
              <option value="">All stored results</option>
              {data.availableDates.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
            <select name="pageSize" defaultValue={pageSize} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700"><option value="25">25 rows</option><option value="50">50 rows</option><option value="100">100 rows</option></select>
            <button className="min-h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">Apply</button>
            <input type="hidden" name="sort" value={sort}/><input type="hidden" name="dir" value={descending ? "desc" : "asc"}/>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone="indigo">{data.allResults ? "All categories" : data.snapshot.categoryLabel || data.snapshot.researchTerm || "All eBay"}</Badge>
            {data.snapshot.categoryLabel && data.snapshot.researchTerm !== categorySearchTerm && <span>Keyword: {data.snapshot.researchTerm}</span>}
            <span>Captured {captured?.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
            <span>·</span><span>{data.allResults ? `${data.combinedSnapshots} snapshots combined` : `${data.snapshot.requestedResults ?? 240}-result request${data.snapshot.fallbackUsed ? " · lighter fallback used" : ""}`}</span>
            <span>·</span><span>Stored filters use 0 credits</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[1160px] w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-white text-[11px] uppercase tracking-[.06em] text-slate-500"><tr>
              <th className="px-4 py-3 font-semibold">#</th>
              <th className="px-4 py-3 font-semibold"><Link href={sortHref("title")} className="hover:text-indigo-600">Product ↕</Link></th>
              <th className="px-4 py-3 text-right font-semibold"><Link href={sortHref("weekSales")} className="hover:text-indigo-600">Last 7d ↕</Link></th>
              <th className="px-4 py-3 text-right font-semibold"><Link href={sortHref("monthSales")} className="hover:text-indigo-600">Last 30d ↕</Link></th>
              <th className="px-4 py-3 text-right font-semibold"><Link href={sortHref("sales")} className="hover:text-indigo-600">Lifetime ↕</Link></th>
              <th className="px-4 py-3 text-right font-semibold"><Link href={sortHref("price")} className="hover:text-indigo-600">Price ↕</Link></th>
              <th className="px-4 py-3 text-right font-semibold">Shipping</th>
              <th className="px-4 py-3 font-semibold"><Link href={sortHref("seller")} className="hover:text-indigo-600">Seller ↕</Link></th>
              <th className="px-4 py-3 font-semibold">Condition</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">{data.rows.map((item, index) => <tr key={item.itemId} className="transition hover:bg-indigo-50/35">
              <td className="px-4 py-3 align-top font-semibold tabular-nums text-slate-400">{(data.page - 1) * data.pageSize + index + 1}</td>
              <td className="px-4 py-3"><div className="flex min-w-[22rem] items-center gap-3">
                {item.imageUrl ? <Image src={item.imageUrl} alt="" width={48} height={48} unoptimized className="h-12 w-12 shrink-0 rounded-lg border border-slate-200 object-contain"/> : <div className="h-12 w-12 shrink-0 rounded-lg bg-slate-100"/>}
                <div className="min-w-0"><a href={item.url} target="_blank" rel="noreferrer" className="line-clamp-2 font-semibold leading-5 text-slate-900 hover:text-indigo-600">{item.title}</a><p className="mt-0.5 text-[11px] text-slate-400">Item {item.itemId}{item.sponsored ? " · Sponsored" : ""}{item.hotness ? ` · ${item.hotness}` : ""}</p></div>
              </div></td>
              <td className="px-4 py-3 text-right align-top font-bold tabular-nums text-emerald-600" title={item.sales7d == null ? "Requires stored observations approximately 7 days apart" : "Reported sold-count increase over approximately 7 days"}>{item.sales7d == null ? "—" : item.sales7d.toLocaleString()}</td>
              <td className="px-4 py-3 text-right align-top font-bold tabular-nums text-emerald-600" title={item.sales30d == null ? "Requires stored observations approximately 30 days apart" : "Reported sold-count increase over approximately 30 days"}>{item.sales30d == null ? "—" : item.sales30d.toLocaleString()}</td>
              <td className="px-4 py-3 text-right align-top"><span className="text-base font-bold tabular-nums text-slate-800">{item.quantitySold.toLocaleString()}</span></td>
              <td className="px-4 py-3 text-right align-top font-semibold tabular-nums text-slate-900">{money(item.priceCents)}<p className="text-[11px] font-normal text-slate-400">{money(item.totalPriceCents)} landed</p></td>
              <td className="px-4 py-3 text-right align-top tabular-nums text-slate-600">{item.shippingCents ? money(item.shippingCents) : "Free"}</td>
              <td className="px-4 py-3 align-top"><p className="max-w-40 truncate font-medium text-slate-700">{item.sellerName}</p><p className="text-[11px] text-slate-400">{item.sellerFeedbackPct != null ? `${item.sellerFeedbackPct}% positive` : "Feedback unavailable"}</p></td>
              <td className="px-4 py-3 align-top"><Badge>{item.condition}</Badge></td>
            </tr>)}</tbody>
          </table>
          {data.rows.length === 0 && <div className="px-5 py-16 text-center text-sm text-slate-500">{query ? "No proven sellers match this search." : "No listings with an explicit positive eBay sold count were found in this snapshot. Try a focused category or keyword."}</div>}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-4 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-slate-500">Page {data.page} of {data.totalPages} · {data.totalRows.toLocaleString()} products</p>
          <div className="flex gap-2"><Link aria-disabled={data.page <= 1} href={data.page <= 1 ? href({ page: 1 }) : href({ page: data.page - 1 })} className={`rounded-lg border px-3 py-2 font-semibold ${data.page <= 1 ? "pointer-events-none text-slate-300" : "text-slate-700 hover:bg-slate-50"}`}>Previous</Link><Link aria-disabled={data.page >= data.totalPages} href={data.page >= data.totalPages ? href({ page: data.totalPages }) : href({ page: data.page + 1 })} className={`rounded-lg border px-3 py-2 font-semibold ${data.page >= data.totalPages ? "pointer-events-none text-slate-300" : "text-slate-700 hover:bg-slate-50"}`}>Next</Link></div>
        </div>
      </Card>
      <p className="px-1 text-xs leading-5 text-slate-500">Lifetime sales is eBay’s reported cumulative sold quantity. Last 7d and Last 30d are the increase between locally stored observations near those dates. A dash means Sellfinity does not yet have enough history; it is not treated as zero.</p>
    </> : <Card className="px-6 py-16 text-center"><div className="mx-auto max-w-xl"><p className="text-lg font-bold text-slate-900">No bestseller snapshot yet</p><p className="mt-2 text-sm leading-6 text-slate-500">Run one refresh to collect up to 240 listings in a single broad request. Sellfinity will save and reuse that data without spending more trial credits when you search, sort, paginate, or revisit the page.</p></div></Card>}
  </div>;
}
