"use client";

/* eslint-disable @next/next/no-img-element */

import { useMemo, useState, useTransition } from "react";
import { importProducts } from "@/lib/actions/sourcing";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";

export type CandidateRow = {
  id: string;
  title: string;
  category: string;
  imageUrl: string | null;
  supplierName: string;
  costCents: number;
  marketPriceCents: number;
  estimatedProfitCents: number;
  marginPct: number;
  salesPerWeek: number;
  competitorCount: number;
  stock: number;
  score: number;
  imported: boolean;
};

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 65 ? "green" : score >= 40 ? "amber" : "slate";
  return <Badge tone={tone}>{score}</Badge>;
}

export function SourcingTable({
  rows,
  categories,
}: {
  rows: CandidateRow[];
  categories: string[];
}) {
  const [category, setCategory] = useState<string>("all");
  const [minMargin, setMinMargin] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{
    total: number;
    imported: number;
    skipped: number;
    complete: boolean;
    error?: string;
  } | null>(null);

  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          (category === "all" || r.category === category) &&
          r.marginPct >= minMargin,
      ),
    [rows, category, minMargin],
  );

  const selectableVisible = visible.filter((r) => !r.imported);
  const allSelected =
    selectableVisible.length > 0 &&
    selectableVisible.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(
      allSelected ? new Set() : new Set(selectableVisible.map((r) => r.id)),
    );
  }

  function runImport(ids: string[]) {
    setNotice(null);
    setImportProgress({ total: ids.length, imported: 0, skipped: 0, complete: false });
    startTransition(async () => {
      const result = await importProducts(ids);
      if (result.error) {
        setImportProgress({ total: ids.length, imported: result.imported, skipped: result.skipped, complete: true, error: result.error });
        setNotice(result.error);
      } else {
        setImportProgress({ total: ids.length, imported: result.imported, skipped: result.skipped, complete: true });
        setNotice(
          `Imported ${result.imported} product${result.imported === 1 ? "" : "s"} to inventory` +
            (result.skipped ? ` (${result.skipped} already imported)` : "") +
            ". Head to Listings to publish them.",
        );
        setSelected(new Set());
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="min-h-10 min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13px]"
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
          className="min-h-10 min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13px]"
        >
          <option value={0}>Any margin</option>
          <option value={15}>Margin ≥ 15%</option>
          <option value={25}>Margin ≥ 25%</option>
          <option value={35}>Margin ≥ 35%</option>
        </select>
        <div className="col-span-2 flex items-center gap-3 sm:ml-auto">
          {notice && <p className="text-sm text-emerald-700">{notice}</p>}
          <Button className="ml-auto sm:ml-0"
            onClick={() => runImport([...selected])}
            disabled={pending || selected.size === 0}
          >
            {pending ? "Importing…" : `Import selected (${selected.size})`}
          </Button>
        </div>
      </div>

      {importProgress && (
        <PremiumProgress
          title={importProgress.complete ? "Inventory import complete" : "Importing sourcing candidates"}
          subtitle={importProgress.error ?? (importProgress.complete
            ? "Imported products are ready for listing creation."
            : "Creating inventory records and preserving source pricing for each selected product.")}
          percentage={importProgress.complete ? 100 : undefined}
          status={importProgress.error ? "error" : importProgress.complete ? "complete" : "running"}
          stats={[
            { label: "selected", value: importProgress.total },
            { label: "imported", value: importProgress.imported, tone: "success" },
            ...(importProgress.skipped ? [{ label: "already imported", value: importProgress.skipped, tone: "warning" as const }] : []),
          ]}
        />
      )}

      <div className="space-y-3 sm:hidden">{visible.map((row) => <article key={row.id} className={cx("rounded-2xl border bg-white p-4 shadow-sm", selected.has(row.id) ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-200")}><div className="flex items-start gap-3"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} disabled={row.imported} aria-label={`Select ${row.title}`} className="mt-4 h-5 w-5 rounded border-slate-300"/>{row.imageUrl ? <img src={row.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl bg-slate-100 object-cover"/> : <div className="h-14 w-14 shrink-0 rounded-xl bg-slate-100"/>}<div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><p className="line-clamp-2 text-[13px] font-semibold leading-5 text-slate-950">{row.title}</p><ScoreBadge score={row.score}/></div><p className="mt-1 text-xs text-slate-500">{row.category} · {row.stock} in stock</p></div></div><div className="mt-3 grid grid-cols-3 rounded-xl bg-slate-50 p-3 text-center"><div><p className="text-[10px] uppercase text-slate-400">Cost</p><p className="mt-1 text-sm font-bold">{formatCents(row.costCents)}</p></div><div className="border-x border-slate-200"><p className="text-[10px] uppercase text-slate-400">Profit</p><p className={cx("mt-1 text-sm font-bold", row.estimatedProfitCents > 0 ? "text-emerald-700" : "text-red-600")}>{formatCents(row.estimatedProfitCents)}</p></div><div><p className="text-[10px] uppercase text-slate-400">Margin</p><p className="mt-1 text-sm font-bold">{row.marginPct}%</p></div></div><div className="mt-3 flex items-center justify-between text-xs text-slate-500"><span>{row.salesPerWeek}/wk · {row.competitorCount} rivals</span>{row.imported ? <Badge tone="indigo">In inventory</Badge> : <Button size="sm" variant="secondary" disabled={pending} onClick={() => runImport([row.id])}>Import</Button>}</div></article>)}{!visible.length && <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">No candidates match these filters.</p>}</div>
      <Card className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3 text-right">Cost</th>
              <th className="px-4 py-3 text-right">Market price</th>
              <th className="px-4 py-3 text-right">Est. profit</th>
              <th className="px-4 py-3 text-right">Margin</th>
              <th className="px-4 py-3 text-right">Sales/wk</th>
              <th className="px-4 py-3 text-right">Rivals</th>
              <th className="px-4 py-3 text-center">Score</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className={cx(
                  "border-b border-slate-100 last:border-0",
                  selected.has(r.id) && "bg-indigo-50/50",
                )}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    disabled={r.imported}
                    aria-label={`Select ${r.title}`}
                  />
                </td>
                <td className="max-w-xs px-4 py-3">
                  <div className="flex items-center gap-3">
                    {r.imageUrl ? (
                      <img
                        src={r.imageUrl}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-lg bg-slate-100 object-cover"
                      />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded-lg bg-slate-100" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900" title={r.title}>
                        {r.title}
                      </p>
                      <p className="text-xs text-slate-500">
                        {r.category} · {r.stock} in stock
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatCents(r.costCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatCents(r.marketPriceCents)}
                </td>
                <td
                  className={cx(
                    "px-4 py-3 text-right font-medium tabular-nums",
                    r.estimatedProfitCents > 0 ? "text-emerald-600" : "text-red-600",
                  )}
                >
                  {formatCents(r.estimatedProfitCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.marginPct}%</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.salesPerWeek}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {r.competitorCount}
                </td>
                <td className="px-4 py-3 text-center">
                  <ScoreBadge score={r.score} />
                </td>
                <td className="px-4 py-3 text-right">
                  {r.imported ? (
                    <Badge tone="indigo">In inventory</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => runImport([r.id])}
                    >
                      Import
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-slate-500">
                  No candidates match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
