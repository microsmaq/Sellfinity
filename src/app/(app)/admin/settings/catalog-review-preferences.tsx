"use client";
import { useState, useTransition } from "react";
import { Button, Card } from "@/components/ui";
import { saveCatalogReviewSettings, reviewPendingCatalogNow } from "@/lib/actions/catalog-review";
import { useRouter } from "next/navigation";

export function CatalogReviewPreferences({ enabled: initialEnabled, dailyLimit: initialLimit, lastRun, summary }: { enabled: boolean; dailyLimit: number; lastRun: string | null; summary: string }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [limit, setLimit] = useState(initialLimit);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return <Card className="p-5"><h2 className="font-bold text-slate-950">Automatic review of pending products</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">Research fresh pending Amazon records daily and publish qualified products to the shared Arbitrage Finder. Requires MATCH at 100%, exact brand and variant evidence, both images, verified shipping, competitive pricing, and at least 15% margin or $6.99 profit. Uncertain results stay in Needs review. This publishes catalog opportunities, not listings to sellers’ eBay stores.</p>
    <p className="mt-2 text-xs leading-5 text-slate-500">Runs daily at 12:00 UTC (5 AM Pacific during daylight saving time, 4 AM otherwise). Reuses stored Amazon data with no Rainforest lookup. eBay/Countdown research and AI assessments can use provider credits. The batch stops safely at its time limit; remaining candidates wait for the next run.</p>
    <label className="mt-4 block text-sm"><input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} /> Enable daily automatic review and publication</label>
    <label className="mt-3 block text-sm">Maximum products per run <select className="ml-2 rounded-lg border p-2" value={limit} disabled={pending} onChange={(event) => setLimit(Number(event.target.value))}>{[1, 5, 10, 25].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <div className="mt-4 flex flex-wrap gap-2"><Button disabled={pending} onClick={() => start(async () => { try { await saveCatalogReviewSettings(enabled, limit); setMessage(enabled ? "Daily review enabled." : "Daily review disabled."); router.refresh(); } catch { setMessage("Could not save automatic review settings."); } })}>Save settings</Button>
      <Button variant="secondary" disabled={pending} onClick={() => start(async () => { setMessage("Reviewing pending products…"); try { const result = await reviewPendingCatalogNow(); setMessage("skipped" in result ? result.reason : `${result.processed} processed · ${result.published} published · ${result.review} need review · ${result.failed} failed · ${result.queued} queued`); router.refresh(); } catch { setMessage("Review could not complete. Saved results are kept; check Product intelligence."); } })}>{pending ? "Working…" : "Review pending products now"}</Button></div>
    <p role="status" className="mt-3 text-sm text-indigo-800">{message}</p>
    {lastRun && <p className="mt-2 text-xs text-slate-500">Last run: {new Date(lastRun).toLocaleString()} · {summary}</p>}
  </Card>;
}
