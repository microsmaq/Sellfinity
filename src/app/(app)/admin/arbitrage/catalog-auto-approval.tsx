"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { prepareCatalogAutoApproval, reviewHighConfidenceCatalogNow } from "@/lib/actions/catalog-review";
import { processCatalogApprovalQueue, type ApprovalProgress } from "@/lib/arbitrage/catalog-approval-queue";

export function CatalogAutoApproval({ selectedIds, disabled, onRunningChange }: { selectedIds: string[]; disabled: boolean; onRunningChange: (running: boolean) => void }) {
  const router = useRouter();
  const active = useRef(false);
  const stop = useRef(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [limit, setLimit] = useState<number | "ALL">(25);
  const [progress, setProgress] = useState<ApprovalProgress>({ total: 0, done: 0, published: 0, review: 0, failed: 0, skipped: 0, items: [] });
  const [message, setMessage] = useState("");

  async function run(selected: boolean) {
    if (active.current) return;
    active.current = true;
    stop.current = false; setStopping(false);
    setRunning(true); onRunningChange(true);
    setProgress({ total: 0, done: 0, published: 0, review: 0, failed: 0, skipped: 0, items: [] });
    setMessage("Preparing eligible high-confidence matches…");
    try {
      const prepared = await prepareCatalogAutoApproval(selected ? selectedIds : undefined, limit);
      if ("skipped" in prepared) { setMessage(prepared.reason); return; }
      if (!prepared.ids.length) { setMessage("No eligible high-confidence matches. Candidates must be in Needs review at 95%+ with a saved eBay comparison and must not have been rejected. Price, profit, availability, shipping and data age do not affect match eligibility."); return; }
      if (stop.current) { setMessage("Stopped before reviewing any products."); return; }
      if ((limit === "ALL" || prepared.ids.length >= 100) && !window.confirm(`Review ${prepared.ids.length.toLocaleString()} eligible products using AI? This uses AI credits and may take a while. Keep this tab open. Qualified products will be approved into Arbitrage Finder, not listed on eBay. You can stop after the current group.`)) { setMessage("Approval cancelled. No products were changed."); return; }
      const outcome = await processCatalogApprovalQueue(prepared.ids, (ids) => reviewHighConfidenceCatalogNow(ids, ids.length), {
        shouldStop: () => stop.current,
        onProgress: (next) => { setProgress(next); setMessage(stop.current ? "Stopping after the current group…" : `Checking saved matches · ${next.done}/${next.total} processed…`); },
      });
      setMessage(outcome.pauseReason ? `Paused: ${outcome.pauseReason}` : outcome.stopped ? "Stopped after the current group. Completed approvals are saved." : "Review complete. Approved products are available in Arbitrage Finder; uncertain products remain in Needs review.");
    } catch {
      setMessage("Approval could not complete. Saved results are kept. Refresh Product Intelligence and check Admin Settings → Decisions connection before retrying.");
    } finally {
      active.current = false; setRunning(false); setStopping(false); onRunningChange(false); router.refresh();
    }
  }

  return <section className="border-b border-emerald-100 bg-gradient-to-r from-emerald-50/80 to-white p-5" aria-busy={running}>
    <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center">
      <div className="max-w-2xl"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-slate-950">Auto-approve matching products</h2><Badge tone="green">Decisions API</Badge></div>
        <p className="mt-1 text-xs leading-5 text-slate-600">Identity-only review for saved matches at 95%+. Requires image-aware verification, a Decisions exact-match score of at least 99%, and matching brand, model, pack quantity, size and variant. Uncertain products stay in review.</p>
        <p className="mt-1 text-xs text-slate-500">Profit, competitive pricing, sales metrics, stock, shipping and price-data age do not block admin match approval. Cost figures remain informational; each seller decides whether to list and under which pricing strategy.</p>
        <p className="mt-1 text-xs text-slate-500">Uses saved comparisons, not new Amazon or eBay research. AI usage applies. Keep this tab open; large runs use small checkpoints and each queued product is checked once per run. Daily automation limits are unchanged.</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-end gap-2">
        <label className="text-xs font-medium text-slate-600">Products to check<select className="mt-1 block min-h-10 rounded-lg border border-emerald-200 bg-white px-3 text-sm" disabled={disabled || running} value={limit} onChange={(event) => setLimit(event.target.value === "ALL" ? "ALL" : Number(event.target.value))}>{[5, 10, 25, 50, 100].map((value) => <option key={value} value={value}>{value} products</option>)}<option value="ALL">All eligible products</option></select></label>
        <Button variant="secondary" disabled={disabled || running || !selectedIds.length} onClick={() => void run(true)}>Auto-approve selected ({selectedIds.length})</Button>
        <Button disabled={disabled || running} onClick={() => void run(false)}>{running ? "Checking matches…" : limit === "ALL" ? "Auto-approve all eligible" : "Auto-approve high matches"}</Button>
        {running && <Button variant="secondary" disabled={stopping} onClick={() => { stop.current = true; setStopping(true); setMessage("Stopping after the current group…"); }}>{stopping ? "Stopping…" : "Stop after current group"}</Button>}
      </div>
    </div>
    {(running || message) && <div className="mt-4" aria-live="polite">
      <div className="mb-2 flex flex-wrap justify-between gap-1 text-xs text-slate-600"><span>{progress.done}/{progress.total} processed</span><span>{progress.published} approved · {progress.review} need review · {progress.failed} failed · {progress.skipped} no longer eligible</span></div>
      <div role="progressbar" aria-label="Automatic match approval" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.done} className="h-1.5 overflow-hidden rounded-full bg-emerald-100"><div className={`h-full rounded-full bg-emerald-600 transition-[width] duration-500 motion-reduce:transition-none ${running ? "motion-safe:animate-pulse" : ""}`} style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} /></div>
      <p className="mt-2 text-xs leading-5 text-slate-600">{message}</p>
      {progress.items.length > 0 && <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium text-emerald-800">Show approval activity and reasons</summary><ul className="mt-2 max-h-64 space-y-2 overflow-auto">{progress.items.slice(-200).map((item) => <li key={item.id} className="rounded-lg border border-emerald-100 bg-white p-3"><p className="font-semibold text-slate-800">{item.asin} · {item.outcome === "published" ? "Approved" : item.outcome === "failed" ? "Failed" : "Needs review"}</p><p className="mt-1 text-slate-500">{item.reason}</p></li>)}</ul>{progress.items.length > 200 && <p className="mt-2 text-slate-500">Showing the latest 200 results. Product review reasons are saved in the catalog.</p>}</details>}
    </div>}
  </section>;
}
