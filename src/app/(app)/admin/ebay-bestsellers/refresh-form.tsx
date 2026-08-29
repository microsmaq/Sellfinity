"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { refreshEbayBestSellers } from "@/lib/actions/admin-ebay-bestsellers";

const MAX_PAGES_PER_RUN = 25;
const MAX_EMPTY_PAGES = 5;

type Progress = {
  running: boolean;
  target: number;
  added: number;
  pages: number;
  sampled: number;
  totalStored: number;
  message: string;
  error: boolean;
};

const initialProgress: Progress = {
  running: false,
  target: 20,
  added: 0,
  pages: 0,
  sampled: 0,
  totalStored: 0,
  message: "",
  error: false,
};

export function BestSellerRefreshForm({ defaultTerm = "electronics" }: { defaultTerm?: string }) {
  const router = useRouter();
  const [target, setTarget] = useState(20);
  const [progress, setProgress] = useState(initialProgress);
  const categories = [
    ["electronics", "Electronics"],
    ["home and garden", "Home & garden"],
    ["health and beauty", "Health & beauty"],
    ["toys and hobbies", "Toys & hobbies"],
    ["auto parts", "Auto parts"],
    ["pet supplies", "Pet supplies"],
    ["sporting goods", "Sporting goods"],
    ["clothing shoes accessories", "Fashion & accessories"],
  ] as const;
  const categoryValues = new Set(categories.map(([value]) => value));
  const selectedCategory = categoryValues.has(defaultTerm as typeof categories[number][0]) ? defaultTerm : "electronics";
  const customTerm = categoryValues.has(defaultTerm as typeof categories[number][0]) ? "" : defaultTerm;

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (progress.running) return;
    const submitted = new FormData(event.currentTarget);
    const researchTerm = String(submitted.get("researchTerm") ?? "electronics");
    const custom = String(submitted.get("customTerm") ?? "");
    let added = 0;
    let pages = 0;
    let sampled = 0;
    let totalStored = 0;
    let emptyPages = 0;
    let hasMore = true;
    let failure = "";
    setProgress({ running: true, target, added, pages, sampled, totalStored, message: "Starting eBay research…", error: false });

    while (added < target && pages < MAX_PAGES_PER_RUN && emptyPages < MAX_EMPTY_PAGES && hasMore) {
      const payload = new FormData();
      payload.set("researchTerm", researchTerm);
      payload.set("customTerm", custom);
      const result = await refreshEbayBestSellers(null, payload);
      if (!result?.ok) {
        failure = result?.message || "eBay research could not continue.";
        break;
      }
      const pageAdded = Math.max(0, Number(result.added ?? 0));
      added += pageAdded;
      pages += 1;
      sampled += Math.max(0, Number(result.sampled ?? 0));
      totalStored = Math.max(totalStored, Number(result.totalStored ?? 0));
      hasMore = result.hasMore !== false;
      emptyPages = pageAdded === 0 ? emptyPages + 1 : 0;
      setProgress({
        running: true,
        target,
        added,
        pages,
        sampled,
        totalStored,
        message: `${Math.min(added, target)}/${target} added · checking the next results…`,
        error: false,
      });
    }

    let message = `Added ${added} new proven seller${added === 1 ? "" : "s"}. ${totalStored} stored for this category.`;
    if (failure) message = failure;
    else if (added >= target) message = `Complete — added ${added} new proven sellers. ${totalStored} stored for this category.`;
    else if (!hasMore) message += " Reached the end of available eBay results.";
    else if (emptyPages >= MAX_EMPTY_PAGES) message += " Stopped after 5 pages had no additional products with reported sales.";
    else if (pages >= MAX_PAGES_PER_RUN) message += " Paused at the 25-page API safety limit; run it again to continue.";
    setProgress({ running: false, target, added, pages, sampled, totalStored, message, error: Boolean(failure) });
    router.refresh();
  }

  const percent = progress.target > 0 ? Math.min(100, Math.round((progress.added / progress.target) * 100)) : 0;

  return <div className="w-full xl:w-auto">
    <form onSubmit={run} className="grid w-full gap-2 sm:grid-cols-2 xl:grid-cols-[11rem_13rem_8rem_auto]">
      <label className="sr-only" htmlFor="bestseller-category">Category</label>
      <select id="bestseller-category" name="researchTerm" defaultValue={selectedCategory} disabled={progress.running} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60">
        {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label className="sr-only" htmlFor="bestseller-custom-term">Optional custom keyword</label>
      <input id="bestseller-custom-term" name="customTerm" defaultValue={customTerm} disabled={progress.running} placeholder="Optional custom keyword" className="min-h-10 min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60" />
      <label className="sr-only" htmlFor="bestseller-target">Products to add</label>
      <select id="bestseller-target" value={target} disabled={progress.running} onChange={(event) => setTarget(Number(event.target.value))} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-indigo-500 disabled:opacity-60">
        {[10, 20, 50, 100].map((value) => <option key={value} value={value}>Add {value}</option>)}
      </select>
      <button type="submit" disabled={progress.running} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 active:scale-[.98] disabled:bg-indigo-400">
        {progress.running && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
        {progress.running ? `Adding ${target}…` : `Add at least ${target}`}
      </button>
    </form>

    {(progress.running || progress.pages > 0 || progress.message) && <div className="mt-3 rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className={progress.error ? "font-medium text-red-600" : "font-medium text-slate-600"}>{progress.message}</span>
        <span className="shrink-0 font-bold tabular-nums text-indigo-600">{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-gradient-to-r from-indigo-600 via-violet-500 to-cyan-400 transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-slate-500">{progress.pages} page{progress.pages === 1 ? "" : "s"} checked · {progress.sampled} listing details inspected · 0 Countdown credits</p>
    </div>}
  </div>;
}
