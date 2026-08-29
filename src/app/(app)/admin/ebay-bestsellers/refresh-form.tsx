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
  return <div className="w-full sm:w-auto">
    <form action={action} className="flex w-full flex-col gap-2 sm:flex-row">
      <input name="researchTerm" list="ebay-bestseller-categories" defaultValue={defaultTerm || "electronics"} placeholder="Category or keyword" className="min-h-10 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 sm:w-60" />
      <datalist id="ebay-bestseller-categories"><option value="electronics"/><option value="home and garden"/><option value="health and beauty"/><option value="toys and hobbies"/><option value="auto parts"/><option value="pet supplies"/><option value="sporting goods"/><option value="clothing shoes accessories"/></datalist>
      <SubmitButton />
    </form>
    {state && <p role="status" className={cx("mt-2 text-xs sm:text-right", state.ok ? "text-emerald-600" : "text-red-600")}>{state.message}</p>}
  </div>;
}
