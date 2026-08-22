"use client";

import { useState, useTransition } from "react";
import { Button, Card, Input } from "@/components/ui";
import { setAutoLockProfitableListings, setDefaultTargetProfit, setEbayAdRate, setEbaySitewideDiscount, setPricingStrategy } from "@/lib/actions/profit-protection";
import type { PricingStrategy } from "@/lib/listings/shipping-strategy";

export function ProfitProtectionPreferences({ initialDiscountBps, initialAdRateBps, initialAutoLockProfitableListings, initialTargetProfitEnabled, initialTargetProfitCents, initialPricingStrategy }: { initialDiscountBps: number; initialAdRateBps: number; initialAutoLockProfitableListings: boolean; initialTargetProfitEnabled: boolean; initialTargetProfitCents: number; initialPricingStrategy: string }) {
  const [discount, setDiscount] = useState(String(initialDiscountBps / 100));
  const [adRate, setAdRate] = useState(String(initialAdRateBps / 100));
  const [autoLockProfitable, setAutoLockProfitable] = useState(initialAutoLockProfitableListings);
  const [targetProfitEnabled, setTargetProfitEnabled] = useState(initialTargetProfitEnabled);
  const [targetProfit, setTargetProfit] = useState((initialTargetProfitCents / 100).toFixed(2));
  const [pricingStrategy, setPricingStrategyState] = useState<PricingStrategy>(initialPricingStrategy === "FREE_SHIPPING" || initialPricingStrategy === "BUYER_PAID_SHIPPING" ? initialPricingStrategy : "AI");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const percent = Number(discount);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await setEbaySitewideDiscount(percent);
        if ("error" in result) {
          setMessage({ text: result.error ?? "Could not save the discount.", error: true });
          return;
        }
        setDiscount(String(result.discountBps / 100));
        setMessage({
          text: result.discountBps > 0
            ? `Saved ${(result.discountBps / 100).toFixed(2).replace(/\.00$/, "")}% sitewide discount. Protected prices will use the discounted checkout amount.`
            : "Sitewide discount removed. Protected prices will use the full listing price.",
          error: false,
        });
      } catch {
        setMessage({ text: "Could not save the sitewide discount.", error: true });
      }
    });
  }

  function saveAdRate() {
    const percent = Number(adRate);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await setEbayAdRate(percent);
        if ("error" in result) {
          setMessage({ text: result.error ?? "Could not save the advertising rate.", error: true });
          return;
        }
        setAdRate(String(result.adRateBps / 100));
        setMessage({
          text: `Saved ${(result.adRateBps / 100).toFixed(2).replace(/\.00$/, "")}% advertising rate. Profit estimates, pricing safeguards, and reported profit now include this allowance.`,
          error: false,
        });
      } catch {
        setMessage({ text: "Could not save the advertising rate.", error: true });
      }
    });
  }

  function toggleAutoLock(enabled: boolean) {
    setAutoLockProfitable(enabled);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await setAutoLockProfitableListings(enabled);
        setAutoLockProfitable(result.enabled);
        setMessage({
          text: result.enabled
            ? "Profitable-sale price lock enabled. A profitable sale will add a Price locked tag and protect the listing's current price."
            : "Profitable-sale price lock disabled. Listings will no longer receive automatic one-sale price locks.",
          error: false,
        });
      } catch {
        setAutoLockProfitable(!enabled);
        setMessage({ text: "Could not save the profitable-sale price lock setting.", error: true });
      }
    });
  }

  function saveTargetProfit() {
    const dollars = Number(targetProfit);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await setDefaultTargetProfit(targetProfitEnabled, dollars);
        if ("error" in result) {
          setMessage({ text: result.error ?? "Could not save the target profit.", error: true });
          return;
        }
        setTargetProfitEnabled(result.enabled);
        setTargetProfit((result.targetProfitCents / 100).toFixed(2));
        setMessage({
          text: result.enabled
            ? `Default target saved at $${(result.targetProfitCents / 100).toFixed(2)} net profit per item.`
            : "Default target profit disabled. Standard market-aware profit safeguards will be used.",
          error: false,
        });
      } catch {
        setMessage({ text: "Could not save the target profit.", error: true });
      }
    });
  }

  function saveShippingStrategy() {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await setPricingStrategy(pricingStrategy);
        setPricingStrategyState(result.strategy);
        setMessage({ text: result.strategy === "AI" ? "AI pricing saved. Free shipping stays preferred; buyer-paid shipping is used only when needed, up to $7." : result.strategy === "FREE_SHIPPING" ? "Free-shipping pricing saved." : "Buyer-paid-shipping pricing saved. Shipping is capped at $7 per listing.", error: false });
      } catch {
        setMessage({ text: "Could not save the pricing strategy.", error: true });
      }
    });
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 px-6 py-5">
        <h2 className="text-base font-semibold text-slate-900">eBay fees and promotions</h2>
        <p className="mt-1 text-sm text-slate-600">Use your actual promotion settings so Sellfinity protects the profit you expect to keep.</p>
      </div>
      <div className="divide-y divide-slate-200">
      <div className="p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Pricing strategy</h2>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">AI recommended</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">Choose how new and suggested prices balance a competitive item price with shipping. AI prefers free shipping, then matches the strongest market price and adds only the shipping needed to reach your profit target.</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Buyer-paid shipping never exceeds $7. eBay fees on the item and shipping are included in the profit model.</p>
          </div>
          <div className="flex w-full items-end gap-2 sm:w-auto">
            <label className="w-full sm:w-56">
              <span className="mb-1 block text-xs font-medium text-slate-600">Strategy</span>
              <select value={pricingStrategy} disabled={pending} onChange={(event) => setPricingStrategyState(event.target.value as PricingStrategy)} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100">
                <option value="AI">AI decides (recommended)</option>
                <option value="FREE_SHIPPING">Free shipping</option>
                <option value="BUYER_PAID_SHIPPING">Buyer-paid shipping</option>
              </select>
            </label>
            <Button disabled={pending} onClick={saveShippingStrategy}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div>
      <div className="p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Default target profit per item</h2>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">Default on</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">Use this modeled net-profit target for new mirrored listings, suggested prices, and future-price protection during fulfillment refresh.</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">The calculation includes Amazon item cost and shipping, eBay final-value and per-order fees, your advertising rate, and your sitewide discount. Actual profit can vary if marketplace costs change.</p>
          </div>
          <div className="flex w-full items-end gap-2 sm:w-auto">
            <label className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-3">
              <input type="checkbox" checked={targetProfitEnabled} disabled={pending} onChange={(event) => setTargetProfitEnabled(event.target.checked)} className="h-4 w-4 accent-indigo-600" />
              <span className="text-xs font-medium text-slate-700">Use target</span>
            </label>
            <label className="w-full sm:w-28">
              <span className="mb-1 block text-xs font-medium text-slate-600">Profit $</span>
              <Input type="number" min="0" max="10000" step="0.01" value={targetProfit} disabled={!targetProfitEnabled || pending} onChange={(event) => setTargetProfit(event.target.value)} aria-label="Default net profit per item" />
            </label>
            <Button disabled={pending} onClick={saveTargetProfit}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div>
      <div className="p-6">
        <div className="flex items-start justify-between gap-5">
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Automatically lock profitable listings</h2>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">Recommended</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">After a listing generates one profitable sale, add a separate Price locked tag and protect its current price from automatic repricing.</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">The lock stays active for seven days after the latest profitable sale. Manual changes require confirmation, and automatic price tools skip the listing. Verified Winner remains reserved for consistent profitable sales.</p>
          </div>
          <label className="relative inline-flex min-h-11 shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              checked={autoLockProfitable}
              disabled={pending}
              onChange={(event) => toggleAutoLock(event.target.checked)}
              className="peer sr-only"
              aria-label="Automatically lock profitable listings"
            />
            <span className="h-7 w-12 rounded-full bg-slate-300 transition peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 after:absolute after:left-1 after:top-2.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" />
          </label>
        </div>
      </div>
      <div className="p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-xl">
          <h2 className="text-sm font-semibold text-slate-900">eBay sitewide discount</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Enter the percentage from your active eBay store promotion. Suggested and protected list prices are grossed up so the discounted checkout amount still reaches {targetProfitEnabled ? `your $${Number(targetProfit || 0).toFixed(2)} target profit` : "the standard profit safeguard"}.</p>
          <p className="mt-1 text-xs text-slate-500">Change this whenever you start, stop, or replace the promotion.</p>
        </div>
        <div className="flex w-full items-end gap-2 sm:w-auto">
          <label className="w-full sm:w-28">
            <span className="mb-1 block text-xs font-medium text-slate-600">Discount %</span>
            <Input type="number" min="0" max="50" step="0.1" value={discount} onChange={(event) => setDiscount(event.target.value)} aria-label="eBay sitewide discount percentage" />
          </label>
          <Button disabled={pending} onClick={save}>{pending ? "Saving…" : "Save"}</Button>
        </div>
      </div>
      </div>
      <div className="p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-sm font-semibold text-slate-900">Promoted Listings advertising rate</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Enter the ad rate you use on eBay. Sellfinity deducts this percentage from modeled sale revenue when calculating profit, margins, suggested prices, listing health, analytics, and profit protection.</p>
            <p className="mt-1 text-xs text-slate-500">Use 0% if listings are not promoted. Your requested setting is 9%.</p>
          </div>
          <div className="flex w-full items-end gap-2 sm:w-auto">
            <label className="w-full sm:w-28">
              <span className="mb-1 block text-xs font-medium text-slate-600">Ad rate %</span>
              <Input type="number" min="0" max="50" step="0.1" value={adRate} onChange={(event) => setAdRate(event.target.value)} aria-label="eBay Promoted Listings advertising rate" />
            </label>
            <Button disabled={pending} onClick={saveAdRate}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div>
      </div>
      {message && <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${message.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`} role="status">{message.text}</p>}
    </Card>
  );
}
