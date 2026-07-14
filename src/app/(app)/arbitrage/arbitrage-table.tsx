"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import {
  fetchArbitragePage,
  exportArbitrageExcel,
  hideArbitrageItem,
  mirrorOpportunities,
  mirrorOpportunity,
  researchArbitrageMarket,
  scanForNew,
  verifyArbitrageMatches,
  verifyHistoricalArbitrageMatches,
} from "@/lib/actions/arbitrage";
import type { ArbitragePage, ArbitragePageParams } from "@/lib/arbitrage/store";
import type { OpportunityRow } from "@/lib/arbitrage/scanner";
import { formatCents } from "@/lib/money";
import { suggestedListingPriceCents } from "@/lib/listings/cleanup";
import { Badge, Button, Card, Input, cx } from "@/components/ui";
import { downloadBase64File } from "@/lib/download";

type SortKey = ArbitragePageParams["sortKey"];

const DEFAULT_PARAMS: ArbitragePageParams = {
  page: 1,
  pageSize: 25,
  sortKey: "profit",
  sortDesc: true,
  category: "all",
  minMarginPct: 0,
  query: "",
};

function SortHeader({
  label,
  sortKey,
  params,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  params: ArbitragePageParams;
  onSort: (key: SortKey) => void;
}) {
  const active = params.sortKey === sortKey;
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
        <span className="w-2 text-slate-400">
          {active ? (params.sortDesc ? "↓" : "↑") : ""}
        </span>
      </button>
    </th>
  );
}

export function ArbitrageTable({ initial }: { initial: ArbitragePage }) {
  const [data, setData] = useState(initial);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [queryInput, setQueryInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mirroredNow, setMirroredNow] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [scanning, startScan] = useTransition();
  const [researching, startResearch] = useTransition();
  const [verifying, startVerify] = useTransition();
  const [verifyingHistory, startVerifyHistory] = useTransition();
  const [busyAsin, setBusyAsin] = useState<string | null>(null);
  const [hidingId, setHidingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function load(next: ArbitragePageParams) {
    setParams(next);
    startTransition(async () => {
      setData(await fetchArbitragePage(next));
    });
  }

  function update(partial: Partial<ArbitragePageParams>) {
    load({ ...params, ...partial, page: partial.page ?? 1 });
  }

  function onSearchChange(value: string) {
    setQueryInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => update({ query: value }), 400);
  }

  function onSort(key: SortKey) {
    update(
      params.sortKey === key
        ? { sortDesc: !params.sortDesc }
        : { sortKey: key, sortDesc: true },
    );
  }

  function isMirrored(r: OpportunityRow) {
    return r.mirrored || mirroredNow.has(r.asin);
  }

  const SCAN_TARGET = 50;

  function scanNow() {
    setNotice(null);
    startScan(async () => {
      let added = 0;
      let examined = 0;
      let exhausted = false;
      // Each call is time-boxed server-side; loop until the full target of
      // new items has been researched (or today's sources run dry).
      while (added < SCAN_TARGET && !exhausted) {
        const report = await scanForNew(SCAN_TARGET - added);
        added += report.added;
        examined += report.examined;
        exhausted = report.exhausted;
        setNotice({
          text: `Researching… ${added}/${SCAN_TARGET} new items added (${examined} candidates examined)`,
          error: false,
        });
        if (report.added === 0 && report.examined === 0 && !exhausted) break; // safety
      }
      setNotice({
        text:
          `Scan complete: ${added} new item${added === 1 ? "" : "s"} added (${examined} candidates examined)` +
          (exhausted ? " — today's sources are fully scanned; more tomorrow." : "."),
        error: false,
      });
      setData(await fetchArbitragePage(params));
    });
  }

  function researchPage() {
    setNotice(null);
    startResearch(async () => {
      let updated = 0;
      let unavailable = 0;
      let errors = 0;
      for (let i = 0; i < data.rows.length; i += 10) {
        const results = await researchArbitrageMarket(
          data.rows.slice(i, i + 10).map((row) => ({
            asin: row.asin,
            ebayItemId: row.ebayItemId,
            title: row.title,
          })),
        );
        setData((previous) => ({
          ...previous,
          rows: previous.rows.map((row) => {
            const result = results.find(
              (item) => item.ebayItemId === row.ebayItemId,
            );
            return result?.market
              ? {
                  ...row,
                  ebaySales30d: result.market.estimatedSales30d,
                  competitorCount: result.market.competitorCount,
                  avgCompPriceCents: result.market.averageCompetitorPriceCents,
                  suggestedListingPriceCents: suggestedListingPriceCents(
                    row.amazonPriceCents,
                    0,
                    result.market.averageCompetitorPriceCents,
                  ),
                }
              : row;
          }),
        }));
        updated += results.filter((result) => result.market).length;
        unavailable += results.filter(
          (result) => !result.market && !result.error,
        ).length;
        errors += results.filter((result) => result.error).length;
        setNotice({
          text: `Researching page… ${Math.min(i + 10, data.rows.length)}/${data.rows.length} (${updated} updated)`,
          error: false,
        });
      }
      setNotice({
        text: `Market research complete: ${updated} updated${unavailable ? `, ${unavailable} without comparable results` : ""}${errors ? `, ${errors} failed` : ""}.`,
        error: errors > 0,
      });
    });
  }

  function verifyPageMatches() {
    setNotice(null);
    startVerify(async () => {
      let approved = 0;
      let removed = 0;
      let aiChecked = 0;
      for (let i = 0; i < data.rows.length; i += 10) {
        const results = await verifyArbitrageMatches(
          data.rows.slice(i, i + 10).map((row) => row.ebayItemId),
        );
        approved += results.filter(
          (result) => result.verdict === "MATCH" || result.verdict === "LIKELY",
        ).length;
        removed += results.filter(
          (result) => result.verdict === "REJECTED" || result.verdict === "REVIEW",
        ).length;
        aiChecked += results.filter((result) => result.method === "AI").length;
        setNotice({
          text: `Checking product identity… ${Math.min(i + 10, data.rows.length)}/${data.rows.length}`,
          error: false,
        });
      }
      setData(await fetchArbitragePage(params));
      setSelected(new Set());
      setNotice({
        text: `Match verification complete: ${approved} approved, ${removed} unsafe or uncertain pair${removed === 1 ? "" : "s"} removed${aiChecked ? `, ${aiChecked} checked by AI` : " using strict identity rules (add OPENROUTER_API_KEY to enable AI review)"}.`,
        error: false,
      });
    });
  }

  function verifyAllHistoricalMatches() {
    setNotice(null);
    startVerifyHistory(async () => {
      let processed = 0;
      let approved = 0;
      let removed = 0;
      let aiChecked = 0;
      let remaining = 1;
      for (let batch = 0; remaining > 0 && batch < 1000; batch++) {
        const result = await verifyHistoricalArbitrageMatches(10);
        processed += result.processed;
        approved += result.approved;
        removed += result.removed;
        aiChecked += result.aiChecked;
        remaining = result.remaining;
        setNotice({
          text: `Verifying historical matches… ${processed} processed, ${remaining} remaining (${approved} approved, ${removed} removed)`,
          error: false,
        });
        if (result.processed === 0) break;
      }
      setData(await fetchArbitragePage(params));
      setSelected(new Set());
      setNotice({
        text:
          remaining === 0
            ? `Historical verification complete: ${processed} checked, ${approved} approved, ${removed} unsafe or uncertain pairs removed, ${aiChecked} checked by AI.`
            : `Historical verification paused: ${processed} checked and ${remaining} remain. Run it again to resume.`,
        error: remaining > 0,
      });
    });
  }

  function exportExcel() {
    startTransition(async () => {
      const file = await exportArbitrageExcel(params);
      downloadBase64File(
        file.filename,
        file.base64,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      setNotice({ text: `Exported all ${data.total} matching opportunities to Excel.`, error: false });
    });
  }

  function mirrorOne(row: OpportunityRow) {
    setNotice(null);
    setBusyAsin(row.asin);
    startTransition(async () => {
      const outcome = await mirrorOpportunity(row.asin, row.ebayPriceCents);
      setBusyAsin(null);
      if (outcome.ok) {
        setMirroredNow((prev) => new Set(prev).add(row.asin));
        setNotice({
          text: `Mirrored "${outcome.title}" as a draft priced at ${formatCents(outcome.priceCents!)}.`,
          error: false,
        });
      } else {
        setNotice({ text: outcome.error ?? "Mirroring failed", error: true });
      }
    });
  }

  function hideOne(row: OpportunityRow) {
    setHidingId(row.ebayItemId);
    setNotice(null);
    startTransition(async () => {
      await hideArbitrageItem(row.ebayItemId);
      setData(await fetchArbitragePage(params));
      setSelected((current) => {
        const updated = new Set(current);
        updated.delete(row.asin);
        return updated;
      });
      setHidingId(null);
      setNotice({ text: `Hidden "${row.title}" from your Arbitrage Finder.`, error: false });
    });
  }

  function mirrorSelected() {
    const items = data.rows
      .filter((r) => selected.has(r.asin) && !isMirrored(r))
      .map((r) => ({ asin: r.asin, ebayPriceCents: r.ebayPriceCents }));
    setNotice(null);
    startTransition(async () => {
      const result = await mirrorOpportunities(items);
      setMirroredNow((prev) => {
        const next = new Set(prev);
        for (const asin of result.mirroredAsins) next.add(asin);
        return next;
      });
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

  const selectable = data.rows.filter((r) => !isMirrored(r));
  const allSelected =
    selectable.length > 0 && selectable.every((r) => selected.has(r.asin));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={queryInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search products…"
          className="w-56"
          aria-label="Search products"
        />
        <select
          value={params.category}
          onChange={(e) => update({ category: e.target.value })}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">All categories</option>
          {data.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={params.pageSize}
          onChange={(e) => update({ pageSize: Number(e.target.value), page: 1 })}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          aria-label="Items per page"
        >
          <option value={25}>25 per page</option>
          <option value={50}>50 per page</option>
          <option value={100}>100 per page</option>
        </select>
        <select
          value={params.minMarginPct}
          onChange={(e) => update({ minMarginPct: Number(e.target.value) })}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value={0}>Any margin</option>
          <option value={15}>Margin ≥ 15%</option>
          <option value={25}>Margin ≥ 25%</option>
          <option value={35}>Margin ≥ 35%</option>
        </select>
        <p className="text-sm text-slate-500">
          {data.total.toLocaleString()} researched
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" disabled={scanning} onClick={scanNow}>
            {scanning ? "Researching…" : "Scan for 50 new items"}
          </Button>
          <Button variant="secondary" disabled={researching} onClick={researchPage}>
            {researching ? "Researching market…" : "Research market data"}
          </Button>
          <Button variant="secondary" disabled={verifying} onClick={verifyPageMatches}>
            {verifying ? "Verifying matches…" : "Verify product matches"}
          </Button>
          <Button
            variant="secondary"
            disabled={verifyingHistory}
            onClick={verifyAllHistoricalMatches}
          >
            {verifyingHistory ? "Verifying history…" : "Verify all historical"}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={exportExcel}>
            Export Excel
          </Button>
          <Button disabled={pending || selected.size === 0} onClick={mirrorSelected}>
            {`Mirror selected (${selected.size})`}
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
          {!notice.error && notice.text.startsWith("Mirrored") && (
            <Link href="/listings" className="font-medium text-emerald-800 underline">
              Open Listings →
            </Link>
          )}
        </p>
      )}

      <Card className={cx("overflow-x-auto", pending && "opacity-60")}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected ? new Set() : new Set(selectable.map((r) => r.asin)),
                    )
                  }
                  aria-label="Select all"
                />
              </th>
              <th className="px-4 py-3">Product</th>
              <SortHeader label="eBay price" sortKey="ebayPrice" params={params} onSort={onSort} />
              <SortHeader label="Est. sales/30d" sortKey="sales" params={params} onSort={onSort} />
              <SortHeader label="Competition" sortKey="competition" params={params} onSort={onSort} />
              <SortHeader label="Avg. comp price" sortKey="avgCompPrice" params={params} onSort={onSort} />
              <th className="px-4 py-3 text-right">Suggested price</th>
              <SortHeader label="Amazon price" sortKey="amazonPrice" params={params} onSort={onSort} />
              <SortHeader label="Profit / unit" sortKey="profit" params={params} onSort={onSort} />
              <SortHeader label="Margin" sortKey="margin" params={params} onSort={onSort} />
              <SortHeader label="Found" sortKey="newest" params={params} onSort={onSort} />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr
                key={r.ebayItemId}
                className={cx(
                  "border-b border-slate-100 last:border-0",
                  selected.has(r.asin) && "bg-indigo-50/50",
                )}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(r.asin)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.asin)) next.delete(r.asin);
                        else next.add(r.asin);
                        return next;
                      })
                    }
                    disabled={isMirrored(r)}
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
                        <a href={r.ebayUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                          eBay comp
                        </a>{" "}
                        ·{" "}
                        <a href={r.amazonUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                          Amazon source
                        </a>
                      </p>
                      <p className="mt-1 truncate text-xs text-slate-500" title={r.amazonTitle}>
                        Amazon: {r.amazonTitle}
                      </p>
                      <span title={r.matchReason ?? "This pair has not been checked yet."}>
                        <Badge
                          tone={
                            r.matchVerdict === "MATCH" || r.matchVerdict === "LIKELY"
                              ? "green"
                              : "amber"
                          }
                        >
                          {r.matchVerdict === "UNVERIFIED"
                            ? "Match not checked"
                            : `${r.matchMethod === "AI" ? "AI " : ""}match ${r.matchConfidence}%`}
                        </Badge>
                      </span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {formatCents(r.ebayPriceCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.ebaySales30d}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {r.competitorCount ?? "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {r.avgCompPriceCents !== null
                    ? formatCents(r.avgCompPriceCents)
                    : "—"}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-indigo-700">
                  {formatCents(r.suggestedListingPriceCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatCents(r.amazonPriceCents)}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-emerald-600">
                  {formatCents(r.profitCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.marginPct}%</td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-slate-500">
                  {new Date(r.foundAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <span className="inline-flex items-center gap-2">
                  {isMirrored(r) ? (
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
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => hideOne(r)}>
                      {hidingId === r.ebayItemId ? "Hiding…" : "Hide"}
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-12 text-center text-slate-500">
                  {data.total === 0
                    ? "The research database is empty — run a scan to start filling it."
                    : "No opportunities match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-center gap-4 text-sm">
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || data.page <= 1}
          onClick={() => update({ page: data.page - 1 })}
        >
          ← Previous
        </Button>
        <span className="text-slate-500">
          Page {data.page} of {data.pageCount}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || data.page >= data.pageCount}
          onClick={() => update({ page: data.page + 1 })}
        >
          Next →
        </Button>
      </div>
    </div>
  );
}
