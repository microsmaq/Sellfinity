"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { refreshEbayBestSellers } from "@/lib/actions/admin-ebay-bestsellers";
import { EBAY_BESTSELLER_CATEGORIES } from "@/lib/ebay/bestseller-categories";

const TARGET_OPTIONS = [10, 20, 50, 100, 200, 500, 1000] as const;
const MAX_RETRIES_PER_PAGE = 3;

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

function shuffledCategoryIds(exhausted: Set<string>): string[] {
  return EBAY_BESTSELLER_CATEGORIES
    .map((category) => category.id)
    .filter((id) => !exhausted.has(id))
    .sort(() => Math.random() - 0.5);
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function BestSellerRefreshForm({
  defaultTerm = "electronics",
  defaultCategoryId,
}: {
  defaultTerm?: string;
  defaultCategoryId?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const largeRunConfirmed = useRef(false);
  const cancelRequested = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [showLargeRunWarning, setShowLargeRunWarning] = useState(false);
  const [target, setTarget] = useState(20);
  const [progress, setProgress] = useState(initialProgress);
  const inferredCategory = EBAY_BESTSELLER_CATEGORIES.find((category) => category.searchTerm === defaultTerm);
  const selectedCategory = EBAY_BESTSELLER_CATEGORIES.some((category) => category.id === defaultCategoryId)
    ? defaultCategoryId
    : inferredCategory?.id ?? "293";
  const selectedCategoryTerm = EBAY_BESTSELLER_CATEGORIES.find((category) => category.id === selectedCategory)?.searchTerm;
  const customTerm = defaultTerm === selectedCategoryTerm ? "" : defaultTerm;

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (progress.running) return;
    if (target >= 500 && !largeRunConfirmed.current) {
      setShowLargeRunWarning(true);
      return;
    }
    largeRunConfirmed.current = false;
    setShowLargeRunWarning(false);
    const submitted = new FormData(event.currentTarget);
    const scope = String(submitted.get("categoryId") ?? "RANDOM");
    const custom = String(submitted.get("customTerm") ?? "");
    const randomMode = scope === "RANDOM";
    const exhaustedCategories = new Set<string>();
    let categoryQueue = randomMode ? shuffledCategoryIds(exhaustedCategories) : [scope];
    let added = 0;
    let pages = 0;
    let sampled = 0;
    let totalStored = 0;
    let failure = "";
    let allResultsExhausted = false;
    cancelRequested.current = false;
    setCancelling(false);
    setProgress({ running: true, target, added, pages, sampled, totalStored, message: "Preparing proven-seller research…", error: false });

    while (added < target && !cancelRequested.current) {
      if (categoryQueue.length === 0) {
        categoryQueue = randomMode ? shuffledCategoryIds(exhaustedCategories) : [];
        if (categoryQueue.length === 0) {
          allResultsExhausted = true;
          break;
        }
      }
      const activeCategoryId = randomMode ? categoryQueue.shift()! : scope;
      const activeCategory = EBAY_BESTSELLER_CATEGORIES.find((category) => category.id === activeCategoryId)
        ?? EBAY_BESTSELLER_CATEGORIES[0];
      let result: Awaited<ReturnType<typeof refreshEbayBestSellers>> = null;

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_PAGE && !cancelRequested.current; attempt += 1) {
        const payload = new FormData();
        payload.set("categoryId", activeCategory.id);
        payload.set("customTerm", custom);
        result = await refreshEbayBestSellers(null, payload);
        if (result?.ok) break;
        if (attempt < MAX_RETRIES_PER_PAGE) {
          setProgress({
            running: true,
            target,
            added,
            pages,
            sampled,
            totalStored,
            message: `${activeCategory.label}: temporary error · retrying ${attempt + 1}/${MAX_RETRIES_PER_PAGE}…`,
            error: false,
          });
          await wait(attempt * 1500);
        }
      }

      if (cancelRequested.current) break;
      if (!result?.ok) {
        failure = result?.message || "eBay research could not continue after three attempts.";
        break;
      }
      const pageAdded = Math.max(0, Number(result.added ?? 0));
      added += pageAdded;
      pages += 1;
      sampled += Math.max(0, Number(result.sampled ?? 0));
      totalStored = Math.max(totalStored, Number(result.totalStored ?? 0));
      if (result.hasMore === false) exhaustedCategories.add(activeCategory.id);
      setProgress({
        running: true,
        target,
        added,
        pages,
        sampled,
        totalStored,
        message: `${activeCategory.label} · ${Math.min(added, target)}/${target} unique proven sellers added`,
        error: false,
      });
      if (!randomMode && result.hasMore === false) {
        allResultsExhausted = true;
        break;
      }
    }

    const cancelled = cancelRequested.current;
    let message = `Added ${added} system-wide new proven seller${added === 1 ? "" : "s"}. ${totalStored} unique products stored.`;
    if (failure) message = failure;
    else if (cancelled) message = `Paused by you after adding ${added}. Run again anytime to continue from the saved search positions.`;
    else if (added >= target) message = `Complete — added ${added} system-wide new proven sellers. ${totalStored} unique products stored.`;
    else if (allResultsExhausted) message += randomMode
      ? " All selected eBay categories have reached the end of their available results."
      : " This eBay category has reached the end of its available results; use Random category mix to continue elsewhere.";
    setCancelling(false);
    setProgress({ running: false, target, added, pages, sampled, totalStored, message, error: Boolean(failure) });
    router.refresh();
  }

  const percent = progress.target > 0 ? Math.min(100, Math.round((progress.added / progress.target) * 100)) : 0;

  return <div className="w-full xl:min-w-[46rem] 2xl:min-w-[52rem]">
    <form ref={formRef} onSubmit={run} className="rounded-2xl border border-slate-200/90 bg-gradient-to-br from-white via-white to-indigo-50/70 p-3 shadow-[0_12px_35px_-22px_rgba(79,70,229,.65)] sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.1fr_1.15fr_.8fr_auto] xl:items-end">
        <label className="grid gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500" htmlFor="bestseller-category">
          Search scope
          <select id="bestseller-category" name="categoryId" defaultValue={selectedCategory} disabled={progress.running} className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-slate-800 outline-none transition hover:border-indigo-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 disabled:opacity-60">
            <option value="RANDOM">✦ Random category mix</option>
            {EBAY_BESTSELLER_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500" htmlFor="bestseller-custom-term">
          Narrow with keyword
          <input id="bestseller-custom-term" name="customTerm" defaultValue={customTerm} disabled={progress.running} placeholder="Optional keyword" className="min-h-11 min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none transition placeholder:font-normal focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 disabled:opacity-60" />
        </label>
        <label className="grid gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500" htmlFor="bestseller-target">
          Unique target
          <select id="bestseller-target" value={target} disabled={progress.running} onChange={(event) => { setTarget(Number(event.target.value)); largeRunConfirmed.current = false; setShowLargeRunWarning(false); }} className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold normal-case tracking-normal text-slate-800 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 disabled:opacity-60">
            {TARGET_OPTIONS.map((value) => <option key={value} value={value}>{value.toLocaleString()} new</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={progress.running} className="inline-flex min-h-11 flex-1 shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-indigo-600/25 active:translate-y-0 disabled:translate-y-0 disabled:cursor-wait disabled:opacity-75 xl:flex-none">
            {progress.running && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {progress.running ? `Finding ${target.toLocaleString()}…` : `Find ${target.toLocaleString()} winners`}
          </button>
          {progress.running && <button type="button" onClick={() => { cancelRequested.current = true; setCancelling(true); }} disabled={cancelling} className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60">{cancelling ? "Pausing…" : "Cancel"}</button>}
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-500">Only item IDs never stored anywhere in Sellfinity count toward the target. Known products are skipped before eBay detail calls.</p>

      {(progress.running || progress.pages > 0 || progress.message) && <div className="mt-3 rounded-xl border border-indigo-100 bg-white/90 p-3 shadow-sm" aria-live="polite">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
          <span className={progress.error ? "font-semibold text-red-600" : "font-semibold text-slate-700"}>{progress.message}</span>
          <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-1 font-bold tabular-nums text-indigo-700">{percent}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
          <div className="h-full rounded-full bg-gradient-to-r from-indigo-600 via-violet-500 to-cyan-400 transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span><strong className="text-slate-700">{progress.added.toLocaleString()}</strong> unique added</span>
          <span><strong className="text-slate-700">{progress.pages.toLocaleString()}</strong> pages checked</span>
          <span><strong className="text-slate-700">{progress.sampled.toLocaleString()}</strong> new details inspected</span>
          <span>0 Countdown credits</span>
        </div>
      </div>}
    </form>

    {showLargeRunWarning && typeof document !== "undefined" && createPortal(<div className="fixed inset-0 z-[100] flex min-h-dvh items-center justify-center overflow-y-auto bg-slate-950/45 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="large-bestseller-run-title">
      <div className="my-auto w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 text-xl text-amber-700">!</div>
        <h2 id="large-bestseller-run-title" className="mt-4 text-lg font-extrabold text-slate-900">Large eBay research run</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Finding {target.toLocaleString()} system-wide new proven sellers can take a long time and may require thousands of official eBay search and item-detail requests.</p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-5 text-slate-600">
          <li>It may approach or reach your eBay application&apos;s daily API allowance.</li>
          <li>Keep this page open until the run completes or you press Cancel.</li>
          <li>Progress is saved page by page, so a paused run can continue later.</li>
        </ul>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => setShowLargeRunWarning(false)} className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50">Go back</button>
          <button type="button" onClick={() => { largeRunConfirmed.current = true; setShowLargeRunWarning(false); formRef.current?.requestSubmit(); }} className="min-h-11 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-5 text-sm font-extrabold text-white shadow-lg shadow-amber-500/20 transition hover:-translate-y-0.5">Continue with {target.toLocaleString()}</button>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
