"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { loadOpportunities, mirrorOpportunity } from "@/lib/actions/arbitrage";
import { MAX_OPPORTUNITIES, type OpportunityRow } from "@/lib/arbitrage/scanner";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";

const LOAD_STEP = 50;

export function ArbitrageTable({ initialRows }: { initialRows: OpportunityRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [category, setCategory] = useState("all");
  const [minMargin, setMinMargin] = useState(0);
  const [pending, startTransition] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const [busyAsin, setBusyAsin] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category))].sort(),
    [rows],
  );

  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          (category === "all" || r.category === category) &&
          r.marginPct >= minMargin,
      ),
    [rows, category, minMargin],
  );

  function mirror(row: OpportunityRow) {
    setNotice(null);
    setBusyAsin(row.asin);
    startTransition(async () => {
      const outcome = await mirrorOpportunity(row.asin, row.ebayPriceCents);
      setBusyAsin(null);
      if (outcome.ok) {
        setRows((prev) =>
          prev.map((r) => (r.asin === row.asin ? { ...r, mirrored: true } : r)),
        );
        setNotice({
          text: `Mirrored "${outcome.title}" as a draft priced at ${formatCents(outcome.priceCents!)} — review it in Listings.`,
          error: false,
        });
      } else {
        setNotice({ text: outcome.error ?? "Mirroring failed", error: true });
      }
    });
  }

  function loadMore() {
    setNotice(null);
    startLoadMore(async () => {
      const next = await loadOpportunities(rows.length + LOAD_STEP);
      // Keep local mirrored flags for rows the fresh scan also returned.
      const mirroredAsins = new Set(rows.filter((r) => r.mirrored).map((r) => r.asin));
      const merged = next.map((r) =>
        mirroredAsins.has(r.asin) ? { ...r, mirrored: true } : r,
      );
      if (merged.length <= rows.length) setExhausted(true);
      setRows(merged);
    });
  }

  const atCap = rows.length >= MAX_OPPORTUNITIES;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={minMargin}
          onChange={(e) => setMinMargin(Number(e.target.value))}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value={0}>Any margin</option>
          <option value={15}>Margin ≥ 15%</option>
          <option value={25}>Margin ≥ 25%</option>
          <option value={35}>Margin ≥ 35%</option>
        </select>
        <p className="text-sm text-slate-500">
          {visible.length} of {rows.length} opportunities
        </p>
        {notice && (
          <p
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm",
              notice.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
            )}
          >
            {notice.text}{" "}
            {!notice.error && (
              <Link href="/listings" className="font-medium text-emerald-800 underline">
                Open Listings →
              </Link>
            )}
          </p>
        )}
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3 text-right">eBay price</th>
              <th className="px-4 py-3 text-right">Sales (30d)</th>
              <th className="px-4 py-3 text-right">Amazon price</th>
              <th className="px-4 py-3 text-right">eBay fees</th>
              <th className="px-4 py-3 text-right">Profit / unit</th>
              <th className="px-4 py-3 text-right">Margin</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.asin} className="border-b border-slate-100 last:border-0">
                <td className="max-w-sm px-4 py-3">
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.imageUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded-lg bg-slate-100 object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900" title={r.title}>
                        {r.title}
                      </p>
                      <p className="text-xs text-slate-500">
                        {r.category} ·{" "}
                        <a
                          href={r.ebayUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-600 hover:underline"
                        >
                          eBay comp
                        </a>{" "}
                        ·{" "}
                        <a
                          href={r.amazonUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-600 hover:underline"
                        >
                          Amazon source
                        </a>
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {formatCents(r.ebayPriceCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.ebaySales30d}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatCents(r.amazonPriceCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                  {formatCents(r.feeCents)}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-emerald-600">
                  {formatCents(r.profitCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.marginPct}%</td>
                <td className="px-4 py-3 text-right">
                  {r.mirrored ? (
                    <Badge tone="indigo">In your store</Badge>
                  ) : (
                    <Button size="sm" disabled={pending} onClick={() => mirror(r)}>
                      {busyAsin === r.asin ? "Mirroring…" : "Mirror to my store"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                  No opportunities match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="flex justify-center">
        {atCap || exhausted ? (
          <p className="text-sm text-slate-500">
            That&apos;s everything the scanner found today — check back tomorrow.
          </p>
        ) : (
          <Button variant="secondary" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Scanning…" : `Load ${LOAD_STEP} more`}
          </Button>
        )}
      </div>
    </div>
  );
}
