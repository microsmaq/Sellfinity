"use client";

import { useMemo, useState, useTransition } from "react";
import { importProducts } from "@/lib/actions/sourcing";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";

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
    startTransition(async () => {
      const result = await importProducts(ids);
      if (result.error) {
        setNotice(result.error);
      } else {
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
        <div className="ml-auto flex items-center gap-3">
          {notice && <p className="text-sm text-emerald-700">{notice}</p>}
          <Button
            onClick={() => runImport([...selected])}
            disabled={pending || selected.size === 0}
          >
            {pending ? "Importing…" : `Import selected (${selected.size})`}
          </Button>
        </div>
      </div>

      <Card className="overflow-x-auto">
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
                      // eslint-disable-next-line @next/next/no-img-element
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
