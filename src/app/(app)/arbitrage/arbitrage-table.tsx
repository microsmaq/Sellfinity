"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  fetchArbitragePage,
  exportArbitrageExcel,
  hideArbitrageItem,
  researchArbitrageMarket,
  scanForNew,
  verifyArbitrageMatches,
} from "@/lib/actions/arbitrage";
import {
  createArbitrageMirrorBatch,
  createQualifiedArbitrageMirrorBatch,
} from "@/lib/actions/mirror-batches";
import {
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
} from "@/lib/arbitrage/auto-publish";
import type { ArbitragePage, ArbitragePageParams } from "@/lib/arbitrage/store";
import type { OpportunityRow } from "@/lib/arbitrage/scanner";
import { formatCents } from "@/lib/money";
import { suggestedListingPriceCents } from "@/lib/listings/cleanup";
import { Badge, Button, Card, Input, cx } from "@/components/ui";
import { PremiumProgress, type PremiumProgressStatus } from "@/components/premium-progress";
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

type ArbitrageProgress = {
  kind: "scan" | "market" | "verify" | "publish";
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  examined?: number;
  detail?: string;
  status: PremiumProgressStatus;
};

function ArbitrageProgressCard({ progress, onStop }: { progress: ArbitrageProgress; onStop?: () => void }) {
  const percentage = progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : progress.status === "complete" ? 100 : 4;
  const meta = {
    scan: ["Discovering profitable products", "Researching best-selling products and their exact Amazon variants."],
    market: ["Researching market intelligence", "Updating demand, competition, competitor pricing, and suggested prices."],
    verify: ["Verifying product matches", "Comparing eBay products with their exact Amazon source variants."],
    publish: ["Preparing automatic publishing", "Checking every researched product against your publishing rules."],
  }[progress.kind];
  return (
    <PremiumProgress
      title={progress.status === "complete" ? `${meta[0]} complete` : meta[0]}
      subtitle={progress.detail ?? meta[1]}
      percentage={percentage}
      status={progress.status}
      action={onStop && progress.status !== "complete" ? (
        <Button size="sm" variant="secondary" onClick={onStop}>Stop safely</Button>
      ) : undefined}
      stats={[
        { label: progress.kind === "scan" ? "new products" : "processed", value: `${progress.completed}/${progress.total}` },
        ...(progress.examined !== undefined ? [{ label: "candidates examined", value: progress.examined, tone: "info" as const }] : []),
        { label: progress.kind === "verify" ? "approved" : "updated", value: progress.succeeded, tone: "success" },
        ...(progress.failed > 0 ? [{ label: "need attention", value: progress.failed, tone: "danger" as const }] : []),
      ]}
    />
  );
}

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

export function ArbitrageTable({
  initial,
  initialAutoPublish,
}: {
  initial: ArbitragePage;
  initialAutoPublish: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [queryInput, setQueryInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [scanning, startScan] = useTransition();
  const [researching, startResearch] = useTransition();
  const [verifying, startVerify] = useTransition();
  const [scanTarget, setScanTarget] = useState(50);
  const [busyAsin, setBusyAsin] = useState<string | null>(null);
  const [hidingId, setHidingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [progress, setProgress] = useState<ArbitrageProgress | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopScanRequested = useRef(false);

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
    return r.mirrored;
  }

  function isVerifiedMatch(r: OpportunityRow) {
    return r.matchVerdict === "MATCH" || r.matchVerdict === "LIKELY";
  }

  async function waitForScanRetry(delayMs: number): Promise<boolean> {
    const retryAt = Date.now() + delayMs;
    while (!stopScanRequested.current && Date.now() < retryAt) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !stopScanRequested.current;
  }

  function stopScan() {
    stopScanRequested.current = true;
    setProgress((current) => current && ({
      ...current,
      status: "paused",
      detail: "Stopping safely after the current provider lookup. Completed research is already saved.",
    }));
    setNotice({
      text: "Stopping after the current provider lookup finishes…",
      error: false,
    });
  }

  function scanNow() {
    const SCAN_TARGET = scanTarget;
    stopScanRequested.current = false;
    setNotice(null);
    setProgress({ kind: "scan", completed: 0, total: SCAN_TARGET, succeeded: 0, failed: 0, examined: 0, status: "running" });
    startScan(async () => {
      let added = 0;
      let examined = 0;
      let exhausted = false;
      let errors = 0;
      let consecutiveFailures = 0;
      // Each call is time-boxed server-side; loop until the full target of
      // new items has been researched, today's sources run dry, or the user
      // explicitly stops the scan. The server persists the queue after every
      // small batch, so stopping never discards completed research.
      while (
        added < SCAN_TARGET &&
        !exhausted &&
        !stopScanRequested.current
      ) {
        let report: Awaited<ReturnType<typeof scanForNew>>;
        try {
          report = await scanForNew(SCAN_TARGET - added);
        } catch {
          errors++;
          consecutiveFailures++;
          const retrySeconds = Math.min(15, 2 ** consecutiveFailures);
          setNotice({
            text: `Provider request temporarily failed. Retrying in ${retrySeconds} seconds… ${added}/${SCAN_TARGET} new items added.`,
            error: true,
          });
          setProgress({
            kind: "scan",
            completed: added,
            total: SCAN_TARGET,
            succeeded: added,
            failed: errors,
            examined,
            detail: `Provider request paused. Retrying automatically in ${retrySeconds} seconds…`,
            status: "paused",
          });
          if (!(await waitForScanRetry(retrySeconds * 1000))) break;
          setProgress((current) => current && ({ ...current, status: "running", detail: undefined }));
          continue;
        }
        added += report.added;
        examined += report.examined;
        exhausted = report.exhausted;
        errors += report.errors ?? 0;
        const temporarilyPaused = report.paused ?? false;
        consecutiveFailures = temporarilyPaused
          ? consecutiveFailures + 1
          : report.added > 0 || report.examined > 0
            ? 0
            : consecutiveFailures + 1;
        setNotice({
          text: `Researching exact Amazon variants… ${added}/${SCAN_TARGET} new items added (${examined} candidates examined${errors ? `, ${errors} temporarily failed` : ""})`,
          error: false,
        });
        setProgress({
          kind: "scan",
          completed: added,
          total: SCAN_TARGET,
          succeeded: added,
          failed: errors,
          examined,
          detail: `Finding exact variants · ${added} of ${SCAN_TARGET} requested products added`,
          status: "running",
        });
        if (temporarilyPaused || (report.added === 0 && report.examined === 0 && !exhausted)) {
          const retrySeconds = Math.min(15, 2 ** consecutiveFailures);
          setNotice({
            text: `Provider lookup temporarily paused. Retrying in ${retrySeconds} seconds… ${added}/${SCAN_TARGET} new items added (${examined} examined).`,
            error: false,
          });
          setProgress((current) => current && ({
            ...current,
            status: "paused",
            detail: `Provider lookup paused. Retrying automatically in ${retrySeconds} seconds…`,
          }));
          if (!(await waitForScanRetry(retrySeconds * 1000))) break;
          setProgress((current) => current && ({ ...current, status: "running", detail: undefined }));
        }
      }
      try {
        setData(await fetchArbitragePage(params));
      } catch {
        errors++;
      }
      const stopped = stopScanRequested.current;
      const scanSummary = stopped
        ? `Scan stopped: ${added} product candidate${added === 1 ? "" : "s"} added and ${examined} candidates examined. The queue was saved and will resume next time.`
        : exhausted
          ? `Scan complete: ${added} product candidate${added === 1 ? "" : "s"} added (${examined} candidates examined) — today's sources are fully scanned.`
          : `Scan complete: ${added} product candidate${added === 1 ? "" : "s"} added (${examined} candidates examined)${errors ? ` after recovering from ${errors} temporary provider failure${errors === 1 ? "" : "s"}` : ""}.`;

      setProgress({
        kind: "scan",
        completed: stopped || exhausted ? Math.min(added, SCAN_TARGET) : SCAN_TARGET,
        total: SCAN_TARGET,
        succeeded: added,
        failed: errors,
        examined,
        detail: stopped ? "Scan stopped safely. The persisted queue will resume on your next scan." : scanSummary,
        status: stopped ? "paused" : "complete",
      });

      if (!stopped && initialAutoPublish) {
        setNotice({
          text: `${scanSummary} Checking all available products against the automatic publishing rules…`,
          error: false,
        });
        setProgress({
          kind: "publish",
          completed: 99,
          total: 100,
          succeeded: added,
          failed: errors,
          detail: "Scan finished. Checking match confidence, margin, and prior publishing history.",
          status: "running",
        });
        try {
          const automaticBatch = await createQualifiedArbitrageMirrorBatch();
          if (automaticBatch.error) {
            setProgress((current) => current && ({ ...current, status: "error", completed: 100, detail: automaticBatch.error }));
            setNotice({
              text: `${scanSummary} Automatic publishing could not start: ${automaticBatch.error}`,
              error: true,
            });
            return;
          }
          if (automaticBatch.batchId) {
            router.push(`/mirror/batches/${automaticBatch.batchId}`);
            return;
          }
          setNotice({
            text: `${scanSummary} No unlisted products currently meet the ${AUTO_PUBLISH_MIN_MATCH_CONFIDENCE}% match and ${AUTO_PUBLISH_MIN_MARGIN_PCT}% net-margin rules.`,
            error: false,
          });
          setProgress((current) => current && ({ ...current, status: "complete", completed: 100, detail: "Eligibility check complete. No additional products currently qualify." }));
          return;
        } catch {
          setProgress((current) => current && ({ ...current, status: "error", completed: 100, failed: current.failed + 1, detail: "The automatic eligibility check temporarily failed." }));
          setNotice({
            text: `${scanSummary} The automatic eligibility check temporarily failed; no products were published.`,
            error: true,
          });
          return;
        }
      }
      setNotice({
        text: scanSummary,
        error: errors > 0 && !stopped && added < SCAN_TARGET,
      });
    });
  }

  function researchPage() {
    setNotice(null);
    setProgress({ kind: "market", completed: 0, total: data.rows.length, succeeded: 0, failed: 0, status: "running" });
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
        const completed = Math.min(i + 10, data.rows.length);
        setProgress({
          kind: "market",
          completed,
          total: data.rows.length,
          succeeded: updated,
          failed: errors,
          detail: unavailable ? `${unavailable} products currently have no comparable market results.` : undefined,
          status: completed === data.rows.length ? "complete" : "running",
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
    setProgress({ kind: "verify", completed: 0, total: data.rows.length, succeeded: 0, failed: 0, status: "running" });
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
        const completed = Math.min(i + 10, data.rows.length);
        setProgress({
          kind: "verify",
          completed,
          total: data.rows.length,
          succeeded: approved,
          failed: removed,
          detail: aiChecked ? `${aiChecked} product pairs have been checked by AI.` : undefined,
          status: completed === data.rows.length ? "complete" : "running",
        });
      }
      setData(await fetchArbitragePage(params));
      setSelected(new Set());
      setNotice({
        text: `Match verification complete: ${approved} approved, ${removed} pair${removed === 1 ? "" : "s"} flagged for review or excluded${aiChecked ? `, ${aiChecked} checked by AI` : " using identity rules"}.`,
        error: false,
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
      const result = await createArbitrageMirrorBatch([row.ebayItemId]);
      setBusyAsin(null);
      if (result.error || !result.batchId) {
        setNotice({ text: result.error ?? "Could not create the publishing batch.", error: true });
        return;
      }
      router.push(`/mirror/batches/${result.batchId}`);
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
    const ebayItemIds = data.rows
      .filter((r) => selected.has(r.asin) && isVerifiedMatch(r) && !isMirrored(r))
      .map((r) => r.ebayItemId);
    setNotice(null);
    startTransition(async () => {
      const result = await createArbitrageMirrorBatch(ebayItemIds);
      if (result.error || !result.batchId) {
        setNotice({ text: result.error ?? "Could not create the publishing batch.", error: true });
        return;
      }
      setSelected(new Set());
      router.push(`/mirror/batches/${result.batchId}`);
    });
  }

  const selectable = data.rows.filter((r) => isVerifiedMatch(r) && !isMirrored(r));
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
          {scanning ? (
            <Button variant="secondary" onClick={stopScan}>
              Stop scan
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={scanTarget}
                onChange={(event) => setScanTarget(Number(event.target.value))}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Number of new items to scan"
              >
                <option value={50}>50 items</option>
                <option value={100}>100 items</option>
                <option value={200}>200 items</option>
                <option value={500}>500 items</option>
                <option value={1000}>1,000 items</option>
              </select>
              <Button variant="secondary" onClick={scanNow}>
                Scan for {scanTarget.toLocaleString()} new items
              </Button>
            </div>
          )}
          <Button variant="secondary" disabled={researching} onClick={researchPage}>
            {researching ? "Researching market…" : "Research market data"}
          </Button>
          <Button variant="secondary" disabled={verifying} onClick={verifyPageMatches}>
            {verifying ? "Verifying matches…" : "Verify product matches"}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={exportExcel}>
            Export Excel
          </Button>
          <Button disabled={pending || selected.size === 0} onClick={mirrorSelected}>
            {`Publish selected (${selected.size})`}
          </Button>
        </div>
      </div>

      {progress && (
        <ArbitrageProgressCard
          progress={progress}
          onStop={progress.kind === "scan" && scanning ? stopScan : undefined}
        />
      )}

      {notice && (!progress || progress.status === "complete" || progress.status === "error") && (
        <p
          className={cx(
            "rounded-lg px-3 py-2 text-sm",
            notice.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
          )}
        >
          {notice.text}{" "}
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
              <SortHeader label="Match confidence" sortKey="matchConfidence" params={params} onSort={onSort} />
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
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-6 py-12 text-center text-sm text-slate-500">
                  No matching or reviewable opportunities are currently available. Run a scan
                  to research more candidates.
                </td>
              </tr>
            )}
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
                    disabled={isMirrored(r) || !isVerifiedMatch(r)}
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
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <span title={r.matchReason ?? "This pair has not been checked yet."}>
                    <Badge tone={isVerifiedMatch(r) ? "green" : "amber"}>
                      {r.matchVerdict === "REVIEW" ? "Review" : "Match"} {r.matchConfidence}%
                    </Badge>
                  </span>
                  {r.matchVerdict === "REVIEW" && (
                    <p className="mt-1 text-xs text-amber-700">Exact variant unverified</p>
                  )}
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
                  {isVerifiedMatch(r) ? formatCents(r.suggestedListingPriceCents) : "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <span title={isVerifiedMatch(r) ? undefined : "Candidate price only; exact child variant is not verified."}>
                    {isVerifiedMatch(r) ? formatCents(r.amazonPriceCents) : `~${formatCents(r.amazonPriceCents)}`}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-emerald-600">
                  {isVerifiedMatch(r) ? formatCents(r.profitCents) : "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {isVerifiedMatch(r) ? `${r.marginPct}%` : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-slate-500">
                  {new Date(r.foundAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <span className="inline-flex items-center gap-2">
                  {!isVerifiedMatch(r) ? (
                    <Badge tone="amber">Review candidate</Badge>
                  ) : isMirrored(r) ? (
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
                      {busyAsin === r.asin ? "Creating batch…" : "Publish to eBay"}
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
                <td colSpan={13} className="px-4 py-12 text-center text-slate-500">
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
