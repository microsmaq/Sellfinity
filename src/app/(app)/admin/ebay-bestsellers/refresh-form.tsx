"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  refreshEbayBestSellers,
  type BestSellerRefreshState,
} from "@/lib/actions/admin-ebay-bestsellers";
import { cx } from "@/components/ui";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 active:scale-[.98] disabled:bg-indigo-400">
    {pending && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
    {pending ? "Researching up to 240…" : "Refresh from eBay"}
  </button>;
}

export function BestSellerRefreshForm({ defaultTerm = "electronics" }: { defaultTerm?: string }) {
  const [state, action] = useActionState<BestSellerRefreshState, FormData>(refreshEbayBestSellers, null);
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
  return <div className="w-full sm:w-auto">
    <form action={action} className="grid w-full gap-2 sm:grid-cols-[12rem_14rem_auto]">
      <label className="sr-only" htmlFor="bestseller-category">Category</label>
      <select id="bestseller-category" name="researchTerm" defaultValue={selectedCategory} className="min-h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15">
        {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label className="sr-only" htmlFor="bestseller-custom-term">Optional custom keyword</label>
      <input id="bestseller-custom-term" name="customTerm" defaultValue={customTerm} placeholder="Optional custom keyword" className="min-h-10 min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15" />
      <SubmitButton />
    </form>
    {state && <p role="status" className={cx("mt-2 text-xs sm:text-right", state.ok ? "text-emerald-600" : "text-red-600")}>{state.message}</p>}
  </div>;
}
