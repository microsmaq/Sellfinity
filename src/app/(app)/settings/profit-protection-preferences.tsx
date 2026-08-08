"use client";

import { useState, useTransition } from "react";
import { Button, Card, Input } from "@/components/ui";
import { setEbaySitewideDiscount } from "@/lib/actions/profit-protection";

export function ProfitProtectionPreferences({ initialDiscountBps }: { initialDiscountBps: number }) {
  const [discount, setDiscount] = useState(String(initialDiscountBps / 100));
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

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-xl">
          <h2 className="text-sm font-semibold text-slate-900">eBay sitewide discount</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Enter the percentage from your active eBay store promotion. Verified profit protection will gross up list prices so the discounted sale still earns 5% net profit, capped at $7.</p>
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
      {message && <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${message.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`} role="status">{message.text}</p>}
    </Card>
  );
}
