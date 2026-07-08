"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  loadOpportunities,
  mirrorOpportunities,
  mirrorOpportunity,
} from "@/lib/actions/arbitrage";
import { MAX_OPPORTUNITIES, type OpportunityRow } from "@/lib/arbitrage/scanner";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, Input, cx } from "@/components/ui";

const LOAD_STEP = 50;

type SortKey = "ebayPrice" | "sales" | "amazonPrice" | "profit" | "margin";

const sortValue: Record<SortKey, (r: OpportunityRow) => number> = {
  ebayPrice: (r) => r.ebayPriceCents,
  sales: (r) => r.ebaySales30d,
  amazonPrice: (r) => r.amazonPriceCents,
  profit: (r) => r.profitCents,
  margin: (r) => r.marginPct,
};

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="px-4 py-3 text-right">
      <button
        onClick={() => onSort(sortKey)}
        className={cx(
          "inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide hover:text-slate-900",
          active ? "text-slate-900" : "text-slate-500",
        )}
      >
        {label}
        <span className="w-2 text-slate-400">{active ? (sort.desc ? "↓" : "↑") : ""}</span>
      </button>
    </th>
  );
}

export function ArbitrageTable({ initialRows }: { initialRows: OpportunityRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [category, setCategory] = useState("all");
  const [minMargin, setMinMargin] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "profit",
    desc: true,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const [busyAsin, setBusyAsin] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (category === "all" || r.category === category) &&
        r.marginPct >= minMargin &&
        (q === "" || r.title.toLowerCase().includes(q)),
    );
    const value = sortValue[sort.key];
    return filtered.sort((a, b) =>
      sort.desc ? value(b) - value(a) : value(a) - value(b),
    );
  }, [rows, category, minMargin, query, sort]);

  const selectableVisible = visible.filter((r) => !r.mirrored);
  const allSelected =
    selectableVisible.length > 0 &&
    selectableVisible.every((r) => selected.has(r.asin));

  function onSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: true },
    );
  }

  function toggle(asin: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      return next;
    });
  }

  function markMirrored(asins: Iterable<string>) {
    const set = new Set(asins);
    setRows((prev) =>
      prev.map((r) => (set.has(r.asin) ? { ...r, mirrored: true } : r)),
    );
  }

  function mirrorOne(row: OpportunityRow) {
    setNotice(null);
    setBusyAsin(row.asin);
    startTransition(async () => {
      const outcome = await mirrorOpportunity(row.asin, row.ebayPriceCents);
      setBusyAsin(null);
      if (outcome.ok) {
        markMirrored([row.asin]);
        setNotice({
          text: `Mirrored "${outcome.title}" as a draft priced at ${formatCents(outcome.priceCents!)}.`,
          error: false,
        });
      } else {
        setNotice({ text: outcome.error ?? "Mirroring failed", error: true });
      }
    });
  }

  function mirrorSelected() {
    const items = visible
      .filter((r) => selected.has(r.asin) && !r.mirrored)
      .map((r) => ({ asin: r.asin, ebayPriceCents: r.ebayPriceCents }));
    setNotice(null);
    startTransition(async () => {
      const result = await mirrorOpportunities(items);
      markMirrored(result.mirroredAsins);
      setSelected(new Set());
      const done = result.mirroredAsins.length;
      setNotice({
        text:
          `Mirrored ${done} product${done === 1 ? "" : "s"} as drafts` +
          (result.failed ? ` (${result.failed} failed${result.error ? `: ${result.error}` : ""})` : "") +
          ".",
        error: done === 0,
      });
    });
  }

  function loadMore() {
    setNotice(null);
    startLoadMore(async () => {
      const next = await loadOpportunities(rows.length + LOAD_STEP);
      if (next.length <= rows.length) setExhausted(true);
      setRows(next);
    });
  }

  const atCap = rows.length >= MAX_OPPORTUNITIES;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products…"
          className="w-56"
          aria-label="Search products"
        />
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
        <div className="ml-auto">
          <Button
            disabled={pending || selected.size === 0}
            onClick={mirrorSelected}
          >
            {pending && busyAsin === null
              ? "Mirroring…"
              : `Mirror selected (${selected.size})`}
          </Button>
        </div>
      </div>

      {notice && (
        <p
          className={cx(
            "rounded-lg px-3 py-2 text-sm",
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

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected
                        ? new Set()
                        : new Set(selectableVisible.map((r) => r.asin)),
                    )
                  }
                  aria-label="Select all"
                />
              </th>
              <th className="px-4 py-3">Product</th>
              <SortHeader label="eBay price" sortKey="ebayPrice" sort={sort} onSort={onSort} />
              <SortHeader label="Sales (30d)" sortKey="sales" sort={sort} onSort={onSort} />
              <SortHeader label="Amazon price" sortKey="amazonPrice" sort={sort} onSort={onSort} />
              <th className="px-4 py-3 text-right">eBay fees</th>
              <SortHeader label="Profit / unit" sortKey="profit" sort={sort} onSort={onSort} />
              <SortHeader label="Margin" sortKey="margin" sort={sort} onSort={onSort} />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.asin}
                className={cx(
                  "border-b border-slate-100 last:border-0",
                  selected.has(r.asin) && "bg-indigo-50/50",
                )}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(r.asin)}
                    onChange={() => toggle(r.asin)}
                    disabled={r.mirrored}
                    aria-label={`Select ${r.title}`}
                  />
                </td>
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
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  {r.mirrored ? (
                    r.storeEbayUrl ? (
                      <a
                        href={r.storeEbayUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20 hover:bg-indigo-100"
                      >
                        My eBay listing ↗
                      </a>
                    ) : (
                      <Link href="/listings">
                        <Badge tone="indigo">Draft in store →</Badge>
                      </Link>
                    )
                  ) : (
                    <Button size="sm" disabled={pending} onClick={() => mirrorOne(r)}>
                      {busyAsin === r.asin ? "Mirroring…" : "Mirror to my store"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-slate-500">
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
