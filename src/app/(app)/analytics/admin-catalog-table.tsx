import Link from "next/link";
import { formatCents } from "@/lib/money";

type CatalogRow = { asin: string; amazonTitle: string; amazonImageUrl: string | null; category: string; suggestedPriceCents: number | null; averageCompetitorPriceCents: number | null; updatedAt: string };

export function AdminCatalogTable({ rows, count, page, search, sort, startDate, endDate }: { rows: CatalogRow[]; count: number; page: number; search: string; sort: string; startDate: string; endDate: string }) {
  const pages = Math.max(1, Math.ceil(count / 50));
  function pageUrl(next: number) {
    const params = new URLSearchParams({ from: startDate, to: endDate, catalogSearch: search, catalogSort: sort, catalogPage: String(next) });
    return `/analytics?${params.toString()}#catalog`;
  }
  return <section id="catalog" className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
    <h2 className="text-lg font-semibold">All catalog products</h2>
    <p className="mt-1 text-sm text-slate-500">Search the complete admin catalog. Open an ASIN to see its detailed report.</p>
    <form action="/analytics#catalog" className="mt-4 flex flex-wrap gap-2">
      <input type="hidden" name="from" value={startDate} /><input type="hidden" name="to" value={endDate} />
      <input aria-label="Search catalog products" name="catalogSearch" defaultValue={search} placeholder="Search product or ASIN" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      <select aria-label="Sort catalog" name="catalogSort" defaultValue={sort} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
        <option value="title">Product name</option><option value="activity">Recently updated</option><option value="suggested">Suggested price</option><option value="competitor">Competitor price</option>
      </select>
      <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Search</button>
    </form>
    <p className="mt-4 text-xs text-slate-500">{count.toLocaleString()} matching products · page {page} of {pages}</p>
    <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead><tr className="text-xs text-slate-500"><th className="py-3">Product</th><th>Category</th><th>Competitor avg.</th><th>Suggested</th><th>Updated</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.asin} className="border-t border-slate-100"><td className="py-3 pr-4"><Link className="font-medium text-indigo-700 hover:underline" href={`/analytics/asins/${encodeURIComponent(row.asin)}`}>{row.amazonTitle}<span className="block text-xs text-slate-500">{row.asin}</span></Link></td><td>{row.category}</td><td>{row.averageCompetitorPriceCents == null ? "—" : formatCents(row.averageCompetitorPriceCents)}</td><td>{row.suggestedPriceCents == null ? "—" : formatCents(row.suggestedPriceCents)}</td><td>{row.updatedAt.slice(0, 10)}</td></tr>)}
    </tbody></table></div>
    {!rows.length && <p className="py-6 text-sm text-slate-500">No catalog products on this page.</p>}
    <div className="mt-4 flex gap-3 text-sm font-medium text-indigo-700">{page > 1 && <Link href={pageUrl(page - 1)}>← Previous</Link>}{page < pages && <Link href={pageUrl(page + 1)}>Next →</Link>}</div>
  </section>;
}
