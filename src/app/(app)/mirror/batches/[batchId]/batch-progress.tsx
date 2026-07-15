"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  processNextMirrorBatchItem,
  type MirrorBatchView,
} from "@/lib/actions/mirror-batches";
import { formatCents } from "@/lib/money";
import { Badge, Card } from "@/components/ui";

function statusTone(status: string): "green" | "red" | "indigo" | "slate" {
  if (status === "SUCCEEDED") return "green";
  if (status === "FAILED") return "red";
  if (status === "PROCESSING") return "indigo";
  return "slate";
}

export function BatchProgress({ initial }: { initial: MirrorBatchView }) {
  const [batch, setBatch] = useState(initial);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (initial.status === "COMPLETED" || running.current) return;
    let cancelled = false;
    running.current = true;

    async function advance() {
      while (!cancelled) {
        try {
          const next = await processNextMirrorBatchItem(initial.id);
          if (!next || cancelled) break;
          setBatch(next);
          setConnectionError(null);
          if (next.status === "COMPLETED") break;
        } catch (error) {
          if (!cancelled) {
            setConnectionError(
              error instanceof Error
                ? error.message
                : "Progress temporarily disconnected. Retrying…",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      running.current = false;
    }

    void advance();
    return () => {
      cancelled = true;
      running.current = false;
    };
  }, [initial.id, initial.status]);

  const processed = batch.succeededCount + batch.failedCount;
  const progressPct = batch.totalCount
    ? Math.round((processed / batch.totalCount) * 100)
    : 0;
  const successPct = batch.totalCount
    ? Math.round((batch.succeededCount / batch.totalCount) * 100)
    : 0;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-600">
              {batch.source === "ARBITRAGE" ? "Arbitrage Finder batch" : "Amazon URL batch"}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-900">
              {batch.status === "COMPLETED"
                ? "Publishing complete"
                : "Publishing directly to eBay…"}
            </h2>
          </div>
          <Badge tone={batch.status === "COMPLETED" ? "green" : "indigo"}>
            {batch.status.toLowerCase()}
          </Badge>
        </div>

        <div className="mt-5 h-4 overflow-hidden rounded-full bg-slate-100" aria-label={`${progressPct}% complete`}>
          <div
            className="h-full rounded-full bg-indigo-600 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-sm text-slate-600">
          <span>{processed} of {batch.totalCount} processed</span>
          <span>{progressPct}% complete</span>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Total</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{batch.totalCount}</p>
          </div>
          <div className="rounded-lg bg-emerald-50 p-3">
            <p className="text-xs uppercase tracking-wide text-emerald-700">Published</p>
            <p className="mt-1 text-2xl font-semibold text-emerald-800 tabular-nums">{batch.succeededCount}</p>
          </div>
          <div className="rounded-lg bg-red-50 p-3">
            <p className="text-xs uppercase tracking-wide text-red-700">Failed</p>
            <p className="mt-1 text-2xl font-semibold text-red-800 tabular-nums">{batch.failedCount}</p>
          </div>
          <div className="rounded-lg bg-indigo-50 p-3">
            <p className="text-xs uppercase tracking-wide text-indigo-700">Listed successfully</p>
            <p className="mt-1 text-2xl font-semibold text-indigo-800 tabular-nums">{successPct}%</p>
          </div>
        </div>

        {connectionError && (
          <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {connectionError}
          </p>
        )}
        {batch.status === "COMPLETED" && (
          <div className="mt-4 space-y-3">
            <p className={`text-sm ${batch.emailStatus === "SENT" ? "text-emerald-700" : batch.emailStatus === "FAILED" ? "text-amber-700" : "text-slate-600"}`}>
              {batch.emailStatus === "SENT"
                ? "A publishing summary was emailed to you."
                : batch.emailStatus === "FAILED"
                  ? "The batch completed, but the email summary could not be sent. The result is saved in batch history."
                  : "Preparing your email summary…"}
            </p>
            <div className="flex gap-4 text-sm">
              <Link href="/listings" className="font-medium text-indigo-600 hover:underline">
                View active listings →
              </Link>
              <Link href="/mirror" className="font-medium text-indigo-600 hover:underline">
                Start another batch →
              </Link>
            </div>
          </div>
        )}
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3 text-right">Amazon source</th>
              <th className="px-4 py-3 text-right">eBay list price</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Result</th>
            </tr>
          </thead>
          <tbody>
            {batch.items.map((item) => (
              <tr key={item.id} className="border-b border-slate-100 last:border-0 align-top">
                <td className="px-4 py-3 text-slate-500 tabular-nums">{item.position + 1}</td>
                <td className="max-w-md px-4 py-3">
                  <p className="font-medium text-slate-900">{item.title ?? "Waiting to research…"}</p>
                  <a
                    href={item.inputUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block max-w-sm truncate text-xs text-indigo-600 hover:underline"
                  >
                    Amazon source ↗
                  </a>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {item.sourcePriceCents === null ? "—" : formatCents(item.sourcePriceCents)}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {item.listingPriceCents === null ? "—" : formatCents(item.listingPriceCents)}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={statusTone(item.status)}>{item.status.toLowerCase()}</Badge>
                </td>
                <td className="max-w-md px-4 py-3">
                  {item.ebayListingId ? (
                    <a
                      href={`https://www.ebay.com/itm/${item.ebayListingId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-indigo-600 hover:underline"
                    >
                      View eBay listing ↗
                    </a>
                  ) : item.error ? (
                    <span className="text-red-700">{item.error}</span>
                  ) : item.status === "PROCESSING" ? (
                    <span className="text-indigo-700">Creating and publishing…</span>
                  ) : (
                    <span className="text-slate-400">Pending</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
