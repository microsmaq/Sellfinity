"use client";

import { useRef, useState } from "react";

type BatchResponse = {
  processed: number;
  succeeded: number;
  failed: number;
  nextCursor: string | null;
  remaining: number;
  done: boolean;
  rainforestRequests: number;
  results: {
    ok: boolean;
    asin: string;
    matchVerdict?: string;
    matchConfidence?: number;
    marketFallback?: boolean;
    error?: string;
  }[];
};

export function EbayMetricsRefreshRunner() {
  const stopped = useRef(false);
  const [running, setRunning] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [succeeded, setSucceeded] = useState(0);
  const [failed, setFailed] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [fallbacks, setFallbacks] = useState(0);
  const [message, setMessage] = useState(
    "Ready to refresh all saved Amazon/eBay pairs. Rainforest is not used.",
  );

  async function start() {
    stopped.current = false;
    setRunning(true);
    setProcessed(0);
    setSucceeded(0);
    setFailed(0);
    setFallbacks(0);
    setMessage("Starting production eBay market and match refresh…");
    let cursor: string | undefined;
    let completed = 0;
    let successes = 0;
    let failures = 0;
    let fallbackCount = 0;

    try {
      while (!stopped.current) {
        let response: Response | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          response = await fetch("/api/admin/arbitrage/refresh-ebay-metrics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cursor, batchSize: 10 }),
          });
          if (response.ok) break;
          if (attempt === 3) {
            throw new Error(`Refresh request failed (${response.status}).`);
          }
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        }

        const batch = (await response!.json()) as BatchResponse;
        if (batch.rainforestRequests !== 0) {
          throw new Error("Safety stop: an unexpected Amazon request was reported.");
        }
        completed += batch.processed;
        successes += batch.succeeded;
        failures += batch.failed;
        fallbackCount += batch.results.filter(
          (result) => result.ok && result.marketFallback,
        ).length;
        cursor = batch.nextCursor ?? undefined;
        setProcessed(completed);
        setSucceeded(successes);
        setFailed(failures);
        setFallbacks(fallbackCount);
        setRemaining(batch.remaining);
        setMessage(
          batch.done
            ? "Refresh complete."
            : `Refreshing current eBay market data and match confidence… ${batch.remaining} remaining`,
        );
        if (batch.done) break;
      }
      if (stopped.current) setMessage("Refresh stopped safely.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The refresh stopped unexpectedly.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/50">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-600">
          Sellfinity administration
        </p>
        <h1 className="mt-2 text-3xl font-bold text-slate-950">
          eBay metrics refresh
        </h1>
        <p className="mt-3 text-slate-600">{message}</p>

        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Processed", processed],
            ["Succeeded", succeeded],
            ["Failed", failed],
            ["Remaining", remaining ?? "—"],
            ["Safe fallbacks", fallbacks],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-medium text-slate-500">{label}</div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-950">
                {value}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all duration-500"
            style={{
              width:
                processed + (remaining ?? 0) > 0
                  ? `${Math.round((processed / (processed + (remaining ?? 0))) * 100)}%`
                  : "0%",
            }}
          />
        </div>

        <div className="mt-7 flex gap-3">
          <button
            type="button"
            onClick={start}
            disabled={running}
            className="rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "Refreshing…" : "Start full refresh"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => {
                stopped.current = true;
                setMessage("Stopping after the current batch…");
              }}
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700"
            >
              Stop safely
            </button>
          )}
        </div>

        <p className="mt-5 text-xs text-slate-500">
          Uses eBay Browse and AI identity scoring only. Stored Amazon price and
          shipping are used for suggested price, profit, and margin calculations.
        </p>
      </div>
    </main>
  );
}
