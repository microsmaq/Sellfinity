"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { prepareCatalogEquivalentResearch, researchCatalogEquivalent } from "@/lib/actions/catalog-equivalents";

type Result = Awaited<ReturnType<typeof researchCatalogEquivalent>>;
export function CatalogEquivalentResearch({ selectedIds, disabled, onRunningChange }: { selectedIds: string[]; disabled: boolean; onRunningChange: (running: boolean) => void }) {
  const router = useRouter();
  const stop = useRef(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ total: 0, done: 0, matched: 0, unmatched: 0, errors: 0, skipped: 0 });
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Result[]>([]);

  async function run(selected: boolean) {
    if (running) return;
    stop.current = false;
    setRunning(true); setMessage("Preparing the research queue…"); setResults([]);
    onRunningChange(true);
    setProgress({ total: 0, done: 0, matched: 0, unmatched: 0, errors: 0, skipped: 0 });
    try {
      const { ids } = await prepareCatalogEquivalentResearch(selected ? selectedIds : undefined);
      const counts = { total: ids.length, done: 0, matched: 0, unmatched: 0, errors: 0, skipped: 0 };
      setProgress({ ...counts });
      if (!ids.length) { setMessage("No eligible products. Verify saved Amazon price, availability and shipping first. Published products are left unchanged."); return; }
      for (const id of ids) {
        if (stop.current) break;
        setMessage(`Researching product ${counts.done + 1} of ${counts.total}…`);
        const result = await researchCatalogEquivalent(id);
        counts.done++;
        if (result.outcome === "error") counts.errors++;
        else counts[result.outcome]++;
        setProgress({ ...counts });
        setResults((current) => [...current, result]);
        if (result.pause) { setMessage(`Paused: ${result.message} Fix the connection or wait before starting again.`); return; }
      }
      setMessage(stop.current ? "Stopped after the current product. Completed matches are saved." : "Research complete. Open Needs review to compare and approve the saved matches.");
    } catch {
      setMessage("Research stopped because the request could not complete. Completed results are saved; remaining pending products can be researched again.");
    } finally {
      setRunning(false); onRunningChange(false); router.refresh();
    }
  }

  return <section className="border-b border-indigo-100 bg-indigo-50/50 p-5">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div><h2 className="font-semibold text-slate-950">Find equivalent eBay products</h2><p className="mt-1 text-xs leading-5 text-slate-600">Search eBay and save comparison images, prices and match confidence. Uses saved Amazon data; no Rainforest or Countdown credits. Results need approval.</p></div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="secondary" disabled={disabled || running || !selectedIds.length} onClick={() => void run(true)}>Research selected ({selectedIds.length})</Button>
        <Button disabled={disabled || running} onClick={() => void run(false)}>Research all pending</Button>
        {running && <Button variant="secondary" onClick={() => { stop.current = true; setMessage("Stopping after the current product…"); }}>Stop</Button>}
      </div>
    </div>
    {(running || message) && <div className="mt-4" aria-live="polite">
      <div className="mb-2 flex flex-wrap justify-between gap-1 text-xs text-slate-600"><span>{progress.done}/{progress.total} processed</span><span>{progress.matched} candidates found · {progress.unmatched} no match · {progress.errors} errors · {progress.skipped} skipped</span></div>
      <div role="progressbar" aria-label="eBay equivalent research" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.done} className="h-2 overflow-hidden rounded-full bg-indigo-100"><div className={`h-full rounded-full bg-indigo-600 transition-[width] duration-500 motion-reduce:transition-none ${running ? "motion-safe:animate-pulse" : ""}`} style={{ width: `${progress.total ? 100 * progress.done / progress.total : 0}%` }} /></div>
      <p className="mt-2 text-xs text-slate-600">{message}</p>
      {results.length > 0 && <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium text-indigo-700">Show research activity</summary><ul className="mt-2 max-h-64 space-y-2 overflow-auto">{results.map((result, index) => <li key={index} className="rounded-md bg-white p-2"><p className="font-medium text-slate-800">{result.title} · {result.outcome}</p><p className="mt-1 text-slate-500">{result.message}</p></li>)}</ul></details>}
    </div>}
  </section>;
}
