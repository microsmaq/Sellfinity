"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Input } from "@/components/ui";
import { importCatalogProducts, filterCatalogImportAsins, prepareCatalogContentRepair, recordCatalogContentCheck } from "@/lib/actions/catalog-import";
import { catalogCsvInputs, catalogImportSchema, type CatalogImportInput } from "@/lib/arbitrage/catalog-import";
import { catalogContentWarnings } from "@/lib/arbitrage/catalog-content";

const template = "asin,title,brand,category,variant,price,shipping,availability,images,description,bulletPoints,bestsellerRank,bestsellerCategory,bestsellerUrl\nB012345678,Product title,Brand,Home,Black,12.99,,AVAILABLE,,,,,,\n";
export function CatalogImporter() {
  const [form, setForm] = useState({ asin: "", title: "", brand: "", category: "", variant: "", description: "", bulletPoints: "", price: "", shipping: "", availability: "UNKNOWN", images: "", bestsellerRank: "", bestsellerCategory: "", bestsellerUrl: "" });
  const [csv, setCsv] = useState("");
  const [json, setJson] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<CatalogImportInput[]>([]);

  async function save(rows: CatalogImportInput[], replace = false) {
    setBusy(true); setMessage("Saving products…");
    const totals = { added: 0, updated: 0, skipped: 0 };
    try {
      for (let i = 0; i < rows.length; i += 50) {
        const result = await importCatalogProducts(rows.slice(i, i + 50), replace);
        totals.added += result.added; totals.updated += result.updated; totals.skipped += result.skipped;
        setMessage(`${Math.min(i + 50, rows.length)}/${rows.length} processed · ${totals.added} added · ${totals.updated} updated · ${totals.skipped} skipped`);
      }
      setPreview([]);
      return totals;
    } finally { setBusy(false); }
  }

  useEffect(() => {
    const receive = async (event: Event) => {
      const detail = (event as CustomEvent<{ requestId: string; rows?: unknown[]; asins?: string[]; operation: string; limit?: number; id?: string }>).detail;
      if (!detail?.requestId) return;
      try {
        const result = detail.operation === "filter"
          ? await filterCatalogImportAsins(detail.asins ?? [])
          : detail.operation === "repairQueue" ? await prepareCatalogContentRepair(detail.limit ?? 100)
          : detail.operation === "contentCheck" ? await recordCatalogContentCheck(detail.id ?? "")
          : await save((detail.rows ?? []).map((row) => catalogImportSchema.parse(row)));
        document.dispatchEvent(new CustomEvent("sellfinity:catalog-import-result", { detail: { requestId: detail.requestId, ok: true, result } }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Import failed";
        setMessage(reason);
        document.dispatchEvent(new CustomEvent("sellfinity:catalog-import-result", { detail: { requestId: detail.requestId, ok: false, error: reason } }));
      }
    };
    document.addEventListener("sellfinity:catalog-import-request", receive);
    document.documentElement.dataset.sellfinityCatalogImportReady = "true";
    return () => { document.removeEventListener("sellfinity:catalog-import-request", receive); delete document.documentElement.dataset.sellfinityCatalogImportReady; };
  }, []);

  function manualInput() {
    const asin = form.asin.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] ?? form.asin.trim().toUpperCase();
    return catalogImportSchema.parse({ ...form, asin, priceCents: Math.round(Number(form.price) * 100), shippingCents: form.shipping.trim() ? Math.round(Number(form.shipping) * 100) : null, images: form.images.split(/\s+/).filter(Boolean), bulletPoints: form.bulletPoints.split("\n").map((line) => line.trim()).filter(Boolean), source: "MANUAL", sourceUrl: `https://www.amazon.com/dp/${asin}`, bestsellerRank: form.bestsellerRank ? Number(form.bestsellerRank) : null, bestsellerUrl: form.bestsellerUrl || null });
  }
  function review(mode: "manual" | "csv" | "json") {
    try {
      const rows = mode === "manual" ? [manualInput()] : mode === "csv" ? catalogCsvInputs(csv) : (JSON.parse(json) as unknown[]).map((row) => catalogImportSchema.parse(row));
      if (!rows.length || rows.length > 1000) throw new Error("Import between 1 and 1,000 products at a time.");
      setPreview(rows); setMessage(`${rows.length} products ready to review.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Check the import data."); }
  }
  return <div className="space-y-5">
    <Link href="/admin/arbitrage" className="text-sm font-semibold text-indigo-700">← Product intelligence</Link>
    <Card className="p-5"><h2 className="font-semibold">Add a product manually</h2><p className="mt-1 text-sm text-slate-600">Paste an ASIN or product URL. Leave shipping blank when unknown. No Amazon or eBay research calls are made.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(form).filter(([key]) => !["availability", "description", "bulletPoints"].includes(key)).map(([key, value]) => <label key={key} className="text-xs font-medium text-slate-600">{{ asin: "Amazon URL / ASIN", title: "Product title", brand: "Brand", category: "Category", variant: "Exact variant / pack size", price: "Item price ($)", shipping: "Shipping ($) — blank = unknown", images: "Amazon image URLs (space separated)", bestsellerRank: "Bestseller rank (optional)", bestsellerCategory: "Bestseller category", bestsellerUrl: "Bestseller source page" }[key]}<Input value={value} onChange={(e) => setForm((current) => ({ ...current, [key]: e.target.value }))} /></label>)}
        <label className="text-xs font-medium text-slate-600">Availability<select className="block min-h-10 w-full rounded-lg border p-2" value={form.availability} onChange={(e) => setForm((current) => ({ ...current, availability: e.target.value }))}><option value="UNKNOWN">Unknown — needs review</option><option value="AVAILABLE">Available</option><option value="UNAVAILABLE">Confirmed unavailable</option></select></label>
      </div><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-slate-600">Product description<textarea aria-label="Product description" maxLength={10000} className="mt-1 block min-h-32 w-full rounded-lg border p-3 text-sm" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label><label className="text-xs font-medium text-slate-600">Feature bullets — one per line<textarea aria-label="Feature bullets" className="mt-1 block min-h-32 w-full rounded-lg border p-3 text-sm" value={form.bulletPoints} onChange={(event) => setForm((current) => ({ ...current, bulletPoints: event.target.value }))} /></label></div><Button className="mt-4" disabled={busy} onClick={() => review("manual")}>Review product</Button>
    </Card>
    <Card className="p-5"><h2 className="font-semibold">Bulk CSV import</h2><p className="mt-1 text-sm text-slate-600">Paste CSV or select a file. Prices are in dollars; separate image URLs and feature bullets with |. Description supports quoted multiline text.</p><button className="my-2 text-sm font-semibold text-indigo-700" onClick={() => { const url = URL.createObjectURL(new Blob([template], { type: "text/csv" })); const link = document.createElement("a"); link.href = url; link.download = "amazon-catalog-template.csv"; link.click(); URL.revokeObjectURL(url); }}>Download template</button><input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; if (file && file.size <= 2_000_000) setCsv(await file.text()); else setMessage("Choose a CSV file smaller than 2 MB."); }} /><textarea aria-label="CSV import data" className="mt-3 block min-h-32 w-full rounded-lg border p-3 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} /><Button className="mt-3" disabled={busy} onClick={() => review("csv")}>Review CSV</Button></Card>
    <Card className="p-5"><h2 className="font-semibold">Browser and AI agent imports</h2><p className="mt-1 text-sm text-slate-600">Use “Add Amazon product” or “Collect this bestseller page” in helper v1.6.6. Re-capturing an existing product fills missing content without changing prices or approved matches. Bestseller discovery still skips existing ASINs. Agents can also fill the manual form or paste a JSON array here.</p><details className="mt-3"><summary className="cursor-pointer text-sm font-medium">JSON input format</summary><pre className="overflow-auto py-3 text-xs">{JSON.stringify({ asin: "B012345678", title: "Product title", category: "Home", description: "Observed Amazon product description", bulletPoints: ["Observed product feature"], images: ["https://m.media-amazon.com/images/I/example.jpg"], priceCents: 1299, shippingCents: null, availability: "AVAILABLE", source: "MANUAL", sourceUrl: "https://www.amazon.com/dp/B012345678" }, null, 2)}</pre><textarea aria-label="JSON product records" className="block min-h-32 w-full rounded-lg border p-3 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} /><Button className="mt-3" disabled={busy} onClick={() => review("json")}>Review JSON</Button></details></Card>
    {preview.length > 0 && <Card className="p-5"><h2 className="font-semibold">Review {preview.length} products</h2><div className="mt-3 max-h-72 overflow-auto">{preview.map((row, i) => <p key={`${row.asin}-${i}`} className="border-b py-2 text-sm">{row.asin} · {row.title} · ${(row.priceCents / 100).toFixed(2)} · Shipping {row.shippingCents === null ? "unknown" : `$${(row.shippingCents / 100).toFixed(2)}`} · {row.availability}<span className="mt-1 block text-xs text-slate-500">{row.images.length} images · {row.bulletPoints.length} feature bullets · {row.description.length} description characters</span>{catalogContentWarnings({ amazonDescription: row.description, amazonTitle: row.title, amazonBulletPointsJson: JSON.stringify(row.bulletPoints), amazonImageUrlsJson: JSON.stringify(row.images) }).map((warning) => <span key={warning} className="mr-2 text-xs text-amber-700">{warning}</span>)}</p>)}</div><label className="my-3 block text-sm"><input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} /> Replace existing prices/source details and return them to Pending review (unchecked: fill missing content only)</label><Button disabled={busy} onClick={() => void save(preview, updateExisting).catch((error) => setMessage(String(error)))}>Save to admin database</Button></Card>}
    <p role="status" className="text-sm text-indigo-800">{message}</p>
  </div>;
}
