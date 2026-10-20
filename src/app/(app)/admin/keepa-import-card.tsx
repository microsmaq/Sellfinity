"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Card } from "@/components/ui";
import { getKeepaDashboardSummary } from "@/lib/actions/keepa-discovery";
import type { getKeepaImportSummary } from "@/lib/keepa/reporting";

type Summary = Awaited<ReturnType<typeof getKeepaImportSummary>>;
const timestamp = (value: string) => `${value.slice(0, 16).replace("T", " ")} UTC`;
export function KeepaImportCard({ initial }: { initial: Summary }) {
  const [data, setData] = useState(initial), [stale, setStale] = useState(false);
  useEffect(() => {
    let active = true, pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try { const next = await getKeepaDashboardSummary(); if (active) { setData(next); setStale(false); } }
      catch { if (active) setStale(true); }
      finally { pending = false; }
    }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const processed = data.preparedAsins - data.queued;
  const progress = data.preparedAsins ? Math.round(processed / data.preparedAsins * 100) : 0;
  const max = Math.max(1, ...data.series.map((point) => point.added));
  const label = !data.configured ? "Not connected" : !data.initialized ? "Starting automatically" : !data.enabled ? data.queued ? "Paused" : "Complete / needs review" : data.schedulerHealthy ? "Running / waiting" : "Waiting for server";
  return <Card className="overflow-hidden p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold text-slate-950">Amazon bestseller imports <Badge tone={data.enabled && data.schedulerHealthy ? "green" : "amber"}>{label}</Badge></h2><p className="mt-1 text-xs text-slate-500">Keepa · autonomous server import · updates here every 15 seconds</p></div><Link href="/admin/arbitrage/keepa" className="rounded-xl bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100">View progress & controls →</Link></div>
    <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{[
      { label: "Added today", value: data.addedToday, note: "Pacific time" },
      { label: "Added to database", value: data.imported, note: "New unique products · lifetime" },
      { label: "Queued for details", value: data.queued, note: "Existing ASINs checked before credits" },
      { label: "Need review", value: data.review, note: "Missing, incomplete or uncertain results" },
    ].map((stat) => <div key={stat.label} className="min-w-0 rounded-xl bg-slate-50 px-3 py-3"><p className="text-[11px] font-medium text-slate-500">{stat.label}</p><p className="mt-1 text-2xl font-bold tabular-nums text-slate-950">{stat.value.toLocaleString("en-US")}</p><p className="mt-1 text-[10px] leading-4 text-slate-500">{stat.note}</p></div>)}</div>
    <div className="mt-4 grid gap-5 lg:grid-cols-[1.5fr_1fr]"><div className="space-y-3"><p role="status" className="text-sm leading-5 text-slate-700">{data.message}</p><div role="progressbar" aria-label="Prepared ASIN queue processed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${progress}%` }} /></div><p className="text-xs text-slate-500">{processed.toLocaleString("en-US")} / {data.preparedAsins.toLocaleString("en-US")} prepared ASINs processed · {data.skipped.toLocaleString("en-US")} known/repeated entries skipped</p><div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500"><span>Tokens today (UTC): <strong className="text-slate-700">{data.spentToday.toLocaleString("en-US")} / {data.dailyBudget.toLocaleString("en-US")}</strong></span><span>{data.checkedAsins.toLocaleString("en-US")} / {data.discoveredAsins.toLocaleString("en-US")} saved list entries checked</span></div><p className="text-xs text-slate-500">Last server check: {data.lastSchedulerAt ? timestamp(data.lastSchedulerAt) : "Waiting for the first scheduled run"}{data.nextRunAt ? ` · Next eligible run: ${timestamp(data.nextRunAt)}` : ""}</p>{stale && <p className="text-xs text-amber-700" role="status">Could not refresh these numbers. Showing the last saved snapshot; the server import runs independently.</p>}</div>
      <div><h3 className="text-xs font-semibold text-slate-700">New Keepa products · last 7 days</h3><div className="mt-3 flex h-28 items-end gap-2" role="img" aria-label={data.series.map((point) => `${point.day}: ${point.added} added`).join("; ")}>{data.series.map((point) => <div key={point.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"><span className="text-[10px] font-medium tabular-nums text-slate-600">{point.added.toLocaleString("en-US")}</span><div title={`${point.day}: ${point.added} added`} className="w-full max-w-9 rounded-t bg-indigo-500" style={{ height: `${Math.max(2, point.added / max * 70)}px`, opacity: point.added ? 1 : 0.15 }} /><span className="text-[9px] text-slate-400">{point.day.slice(5)}</span></div>)}</div><p className="mt-2 text-[10px] text-slate-400">Actual database additions, not API attempts · Pacific time</p></div>
    </div>
  </Card>;
}
