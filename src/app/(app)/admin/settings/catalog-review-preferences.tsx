"use client";
import { useState, useTransition } from "react";
import { Button, Card } from "@/components/ui";
import { saveCatalogReviewSettings, reviewPendingCatalogNow, reviewHighConfidenceCatalogNow } from "@/lib/actions/catalog-review";
import { useRouter } from "next/navigation";

export function CatalogReviewPreferences({ enabled: initialEnabled, dailyLimit: initialLimit, lastRun, summary }: { enabled: boolean; dailyLimit: number; lastRun: string | null; summary: string }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [limit, setLimit] = useState(initialLimit);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return <Card className="p-5"><h2 className="font-bold text-slate-950">Automatic product review and approval</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">Research pending records and reassess saved high-confidence candidates daily based on product identity only. New research requires MATCH at 100%. Saved candidates require image-aware MATCH ≥95% and an independent Decisions match score ≥95% with an explicit conflict score ≤5%, using both images. Shorter titles or missing title details alone are not conflicts; actual brand, model, pack, size and variant differences still block approval. Profit, competitiveness, sales metrics, availability, shipping and data age do not block approval. Existing source flags and prices remain unchanged. Uncertain matches stay in Needs review. Approval makes catalog pairs available in Arbitrage Finder; sellers choose whether to list them on eBay using their own pricing settings.</p>
    <p className="mt-2 text-xs leading-5 text-slate-500">Runs daily at 12:00 UTC (5 AM Pacific during daylight saving time, 4 AM otherwise). Reuses stored Amazon data with no Rainforest lookup. eBay research and AI assessments can use provider credits. The batch stops safely at its time limit; remaining candidates wait for the next run.</p>
    <label className="mt-4 block text-sm"><input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} /> Enable daily automatic review and publication</label>
    <label className="mt-3 block text-sm">Maximum products per run <select className="ml-2 rounded-lg border p-2" value={limit} disabled={pending} onChange={(event) => setLimit(Number(event.target.value))}>{[1, 5, 10, 25].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <div className="mt-4 flex flex-wrap gap-2"><Button disabled={pending} onClick={() => start(async () => { try { await saveCatalogReviewSettings(enabled, limit); setMessage(enabled ? "Daily review enabled." : "Daily review disabled."); router.refresh(); } catch { setMessage("Could not save automatic review settings."); } })}>Save settings</Button>
      <Button variant="secondary" disabled={pending} onClick={() => start(async () => { setMessage("Reviewing pending products…"); try { const result = await reviewPendingCatalogNow(); setMessage("skipped" in result ? result.reason : `${result.processed} processed · ${result.published} published · ${result.review} need review · ${result.failed} failed · ${result.queued} queued`); router.refresh(); } catch { setMessage("Review could not complete. Saved results are kept; check Product intelligence."); } })}>{pending ? "Working…" : "Review pending and high-confidence products now"}</Button><Button variant="secondary" disabled={pending} onClick={() => start(async () => { setMessage("Checking high-confidence Needs review candidates…"); try { const result = await reviewHighConfidenceCatalogNow(); setMessage("skipped" in result ? result.reason : `${result.processed} checked · ${result.published} approved · ${result.review} still need review · ${result.failed} failed`); router.refresh(); } catch { setMessage("Automatic approval could not complete. Unconfirmed items remain in review."); } })}>Auto-approve high-confidence review</Button></div>
    <p role="status" className="mt-3 text-sm text-indigo-800">{message}</p>
    {lastRun && <p className="mt-2 text-xs text-slate-500">Last run: {new Date(lastRun).toLocaleString()} · {summary}</p>}
  </Card>;
}
