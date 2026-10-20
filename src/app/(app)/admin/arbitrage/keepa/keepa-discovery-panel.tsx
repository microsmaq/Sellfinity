"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Input, Label, StatCard } from "@/components/ui";
import { configureKeepaDiscovery, getKeepaDiscoveryStatus, getSavedKeepaProduct, queueKeepaBestsellers, queueKeepaCategories, retryUncertainKeepaRequests } from "@/lib/actions/keepa-discovery";
import type { keepaDiscoveryStatus } from "@/lib/keepa/discovery";

type Status = Awaited<ReturnType<typeof keepaDiscoveryStatus>>;
const formatTime = (value: string) => `${value.slice(0, 16).replace("T", " ")} UTC`;
export function KeepaDiscoveryPanel({ initial }: { initial: Status }) {
  const [state, setState] = useState(initial), [budget, setBudget] = useState(initial.dailyTokenBudget);
  const [selected, setSelected] = useState<string[]>([]), [query, setQuery] = useState("");
  const [manualId, setManualId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [savedAsin, setSavedAsin] = useState("");
  const inFlight = useRef(false);
  const run = useCallback(async (action: () => Promise<Status>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { setState(await action()); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not complete this step. Your saved progress is retained."); }
    finally { inFlight.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    // Read-only polling: closing the browser cannot stop server-side imports.
    const timer = setInterval(() => { void run(getKeepaDiscoveryStatus); }, state.enabled ? 10000 : 30000);
    return () => clearInterval(timer);
  }, [state.enabled, run]);

  const count = (key: string) => state.counts[key] ?? 0;
  const total = Object.values(state.counts).reduce((sum, value) => sum + value, 0);
  const remaining = count("PENDING") + count("FETCHING") + count("SAVED");
  const progress = total ? Math.round((total - remaining) / total * 100) : 0;
  const existing = state.lists.reduce((sum, row) => sum + row.existingCount, 0) + count("SKIPPED");
  const duplicates = state.lists.reduce((sum, row) => sum + row.duplicateCount, 0);
  const categoryOptions = state.categories.filter((row) => row.name.toLowerCase().includes(query.toLowerCase()));
  const choose = (id: string) => setSelected((old) => old.includes(id) ? old.filter((value) => value !== id) : [...old, id]);
  const categories = selected.map((id) => ({ id, name: state.categories.find((row) => row.id === id)?.name ?? `Amazon category ${id}` }));
  const uncertain = count("UNKNOWN") + count("FETCHING") + state.lists.filter((row) => ["UNKNOWN", "FETCHING"].includes(row.status)).length + (["UNKNOWN", "FETCHING"].includes(state.categoryStatus) ? 1 : 0);

  return <div className="space-y-5">
    {!state.configured && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Keepa is not connected. Add KEEPA_API_KEY to the server environment before importing. No credits have been requested by this page.</div>}
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="New products imported" value={count("IMPORTED").toLocaleString()} />
      <StatCard label="Unique products queued" value={remaining.toLocaleString()} sub={`${total.toLocaleString()} unique ASINs tracked`} />
      <StatCard label="Already known · skipped" value={existing.toLocaleString()} sub={`${duplicates.toLocaleString()} repeated list entries skipped`} />
      <StatCard label="Tokens today (UTC)" value={`${state.spentToday.toLocaleString()} / ${state.dailyTokenBudget.toLocaleString()}`} sub={`${state.totalTokens.toLocaleString()} total used or reserved`} />
    </div>
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-semibold text-slate-900">Import progress <Badge tone={state.enabled ? "indigo" : "slate"}>{state.enabled ? "Running / waiting" : "Paused / complete"}</Badge></h2><p role="status" className="mt-2 text-sm text-slate-600">{state.message || "Choose categories to start importing new bestseller products."}</p></div>
        <Button disabled={busy || !state.configured} variant="secondary" onClick={() => void run(() => configureKeepaDiscovery({ enabled: !state.enabled, dailyTokenBudget: budget }))}>{state.enabled ? "Pause after current step" : "Start / resume background import"}</Button>
      </div>
      <div role="progressbar" aria-label="Product import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full bg-indigo-600 transition-[width] duration-500 motion-reduce:transition-none ${busy ? "motion-safe:animate-pulse" : ""}`} style={{ width: `${progress}%` }} /></div>
      <p className="text-xs text-slate-500">{(total - remaining).toLocaleString()} / {total.toLocaleString()} products processed · {count("MISSING")} not returned · {count("REVIEW")} need review · {count("UNKNOWN")} uncertain requests</p>
      {state.nextRunAt && <p className="text-xs text-amber-700">Next eligible step: {formatTime(state.nextRunAt)}</p>}
      <div className="flex flex-wrap items-end gap-3"><div className="w-44"><Label htmlFor="keepa-budget">Daily token budget</Label><Input id="keepa-budget" type="number" min={50} max={28800} value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></div><Button disabled={busy || !Number.isInteger(budget) || budget < 50 || budget > 28800} variant="secondary" onClick={() => void run(() => configureKeepaDiscovery({ enabled: state.enabled, dailyTokenBudget: budget }))}>Save budget</Button><Button disabled={busy || !state.configured} variant="ghost" onClick={() => { setBudget(28800); void run(() => configureKeepaDiscovery({ enabled: state.enabled, dailyTokenBudget: 28800 })); }}>Use full 20/min allowance</Button></div>
      <div className="space-y-2 rounded-xl bg-slate-50 p-3"><Badge tone={state.schedulerHealthy ? "green" : "amber"}>{state.schedulerHealthy ? "Server scheduler responding" : "Server scheduler not confirmed"}</Badge><p className="text-xs text-slate-600">{state.lastSchedulerAt ? `Last server check: ${formatTime(state.lastSchedulerAt)}` : "No server check recorded yet. Configure the Keepa key and CRON_SECRET, then deploy on Vercel Pro."}</p><p className="text-xs leading-5 text-slate-500">Once started, the server checks every minute—even with this page closed or your computer off. It uses available tokens on new ASINs, waits for refills, and resumes automatically. A 28,800-token daily budget permits the full 20/min allowance; lower budgets intentionally stop earlier. Processing stops when paused or when no new products remain.</p></div>
      {uncertain > 0 && <Button disabled={busy} variant="secondary" onClick={() => { if (window.confirm("Retry requests with uncertain outcomes? Keepa may already have charged them. Product requests may cost 1 token each; each list may cost another 50. Already saved successful responses will not be requested again.")) void run(() => retryUncertainKeepaRequests(true)); }}>Retry uncertain requests…</Button>}
    </Card>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <Card className="space-y-4 p-4 sm:p-5">
      <h2 className="font-semibold text-slate-900">Amazon.com bestseller categories</h2>
      <p className="text-sm leading-6 text-slate-600">Each new category list costs 50 tokens. We retain the entire list Keepa returns, not just its first page. Root categories may return up to 500,000 ASINs; subcategories up to 10,000. These are Keepa-ranked lists, not a guaranteed complete list of every Amazon bestseller.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !state.configured} variant="secondary" onClick={() => { if (!state.categories.length || window.confirm("Reload root categories? This costs 1 token.")) void run(() => queueKeepaCategories(Boolean(state.categories.length))); }}>{state.categories.length ? "Reload categories · 1 token" : "Load categories · 1 token"}</Button><Input aria-label="Search categories" placeholder="Search categories" value={query} onChange={(event) => setQuery(event.target.value)} className="max-w-sm" /></div>
      {state.categories.length > 0 && <><Button variant="ghost" onClick={() => setSelected(selected.length === state.categories.length ? [] : state.categories.map((row) => row.id))}>Select / clear all categories</Button><div className="grid max-h-72 gap-2 overflow-y-auto rounded-xl border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-3">{categoryOptions.map((row) => <label key={row.id} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={selected.includes(row.id)} onChange={() => choose(row.id)} className="h-4 w-4 accent-indigo-600" />{row.name}</label>)}</div></>}
      <div className="flex flex-wrap gap-2"><Input aria-label="Amazon category node ID" placeholder="Or enter an Amazon category node ID" value={manualId} onChange={(event) => setManualId(event.target.value)} className="max-w-sm" /><Button variant="secondary" disabled={!/^\d{1,18}$/.test(manualId)} onClick={() => { setSelected((old) => [...new Set([...old, manualId])]); setManualId(""); }}>Add category ID</Button></div>
      <p className="text-xs text-slate-500">{selected.length} categories selected · {categories.filter((row) => !state.lists.some((list) => list.categoryId === row.id)).length * 50} tokens for new lists. Product details normally cost 1 token per new ASIN.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !state.configured || !selected.length} onClick={() => { if (window.confirm("Start importing the selected categories? Each category not already saved costs 50 tokens, then each new ASIN normally costs 1 token. The daily budget limits spending. Existing catalog products and previously tracked ASINs are skipped.")) void run(() => queueKeepaBestsellers(categories)); }}>Import new bestsellers · reuse saved lists</Button><Button variant="secondary" disabled={busy || !state.configured || !selected.length} onClick={() => { if (window.confirm(`Fetch fresh lists for ${selected.length} categories? This may cost ${selected.length * 50} tokens again. Only completed or held lists can be refreshed. Existing ASINs will still be skipped before fetching product details.`)) void run(() => queueKeepaBestsellers(categories, true)); }}>Fetch fresh lists…</Button></div>
    </Card>
    <Card className="overflow-hidden">
      <h2 className="p-4 font-semibold text-slate-900">Saved bestseller lists</h2>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr>{["Category", "Status", "ASINs checked", "New queued", "Known / duplicate", "Fetched"].map((title) => <th key={title} className="whitespace-nowrap px-4 py-3">{title}</th>)}</tr></thead><tbody>{state.lists.map((row) => <tr key={row.categoryId} className="border-t border-slate-100"><td className="max-w-64 px-4 py-3"><span className="font-medium">{row.name}</span>{row.error && <p className="mt-1 text-red-600">{row.error}</p>}</td><td className="px-4 py-3">{row.status}</td><td className="px-4 py-3 tabular-nums">{row.cursor.toLocaleString()} / {row.totalAsins.toLocaleString()}</td><td className="px-4 py-3">{row.queuedCount.toLocaleString()}</td><td className="px-4 py-3">{row.existingCount.toLocaleString()} / {row.duplicateCount.toLocaleString()}</td><td className="whitespace-nowrap px-4 py-3">{row.fetchedAt ? formatTime(row.fetchedAt) : "Not fetched"}</td></tr>)}</tbody></table></div>
    </Card>
    <Card className="space-y-3 p-4 sm:p-5"><h2 className="font-semibold text-slate-900">What gets saved</h2><p className="text-sm leading-6 text-slate-600">Title, brand, description, features, image gallery, category and variant information, plus all returned identifiers, dimensions, A+ content, videos, sales indicators and 90-day history in a saved provider snapshot. No paid offer, stock or rating add-ons are requested. Missing shipping, stock, images or descriptions must be verified or repaired before seller publishing. Existing products are never overwritten or automatically approved.</p><Link href="/admin/arbitrage" className="inline-block text-sm font-semibold text-indigo-600">Open Product intelligence →</Link><div className="flex flex-wrap gap-2"><Input aria-label="ASIN for saved provider snapshot" placeholder="ASIN to download saved details" value={savedAsin} onChange={(event) => setSavedAsin(event.target.value.toUpperCase())} className="max-w-sm" /><Button variant="secondary" disabled={!/^[A-Z0-9]{10}$/.test(savedAsin)} onClick={async () => { try { const json = await getSavedKeepaProduct(savedAsin); const url = URL.createObjectURL(new Blob([json], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `keepa-${savedAsin}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (err) { setError(err instanceof Error ? err.message : "Could not load saved details."); } }}>Download saved details · no credits</Button></div></Card>
    <details className="rounded-xl border border-slate-200 p-4 text-sm"><summary className="cursor-pointer font-medium">Recent imports and review notes</summary><ul className="mt-3 space-y-2">{state.recent.map((row) => <li key={row.asin} className="border-b border-slate-100 pb-2"><span className="font-mono text-xs">{row.asin}</span> · {row.status}{row.error && <p className="mt-1 text-xs text-amber-700">{row.error}</p>}</li>)}</ul></details>
  </div>;
}
