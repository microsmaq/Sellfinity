"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState, useTransition } from "react";
import {
  adminAddAmazonItem,
  adminArchiveItem,
  adminPublishItem,
  adminRecalculateArbitragePricing,
  adminRefreshCatalogBatch,
  adminResearchItem,
  adminScanBestSellers,
  prepareAdminCatalogRefresh,
  prepareAdminLiveAmazonRefresh,
  adminUpdateAmazonCostsFromBrowser,
  adminMarkAmazonUnavailableFromBrowser,
  type AdminRefreshMode,
} from "@/lib/actions/admin-arbitrage";
import type {
  AdminCatalogFilters,
  AdminCatalogPage,
  AdminCatalogRow,
  AdminCatalogSortKey,
  AdminCatalogStatus,
} from "@/lib/arbitrage/admin-catalog";
import { assessPriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";

type AdminScanProgress = {
  target: number;
  added: number;
  examined: number;
  errors: number;
  status: "running" | "paused" | "error";
  detail: string;
};

type AdminRefreshProgress = {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  rainforestRequests: number;
  cacheHits: number;
};

type AdminLiveAmazonProgress = {
  status: "starting" | "running" | "complete" | "cancelled" | "error";
  total: number;
  processed: number;
  found: number;
  unavailable: number;
};

const statusOptions: { value: AdminCatalogStatus; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PUBLISHED", label: "Published" },
  { value: "PENDING", label: "Pending" },
  { value: "NO_MATCH", label: "Needs review" },
  { value: "ARCHIVED", label: "Archived" },
];

function statusTone(status: string): "green" | "amber" | "red" | "slate" {
  if (status === "PUBLISHED") return "green";
  if (status === "PENDING") return "amber";
  if (status === "NO_MATCH") return "red";
  return "slate";
}

function confidenceTone(value: number): "green" | "amber" | "red" {
  if (value >= 90) return "green";
  if (value >= 70) return "amber";
  return "red";
}

function amazonFreshness(value: string | null): string {
  if (!value) return "Amazon data never checked";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Amazon update unknown";
  return `Amazon updated ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp)}`;
}

function CellValue({
  value,
  suffix = "",
}: {
  value: number | null;
  suffix?: string;
}) {
  return value === null ? (
    <span className="text-slate-400">—</span>
  ) : (
    <span className="tabular-nums">{value.toLocaleString()}{suffix}</span>
  );
}

function SortHeader({
  label,
  sortKey,
  filters,
  href,
  align = "right",
  sticky,
}: {
  label: string;
  sortKey: AdminCatalogSortKey;
  filters: AdminCatalogFilters;
  href: string;
  align?: "left" | "right";
  sticky?: "left" | "right";
}) {
  const active = filters.sortKey === sortKey;
  return (
    <th
      className={cx(
        "sticky top-0 z-30 bg-slate-50 px-4 py-3",
        align === "right" ? "text-right" : "text-left",
        sticky === "left" && "left-0 z-40",
        sticky === "right" && "right-0 z-40",
      )}
    >
      <Link
        href={href}
        className={cx(
          "inline-flex items-center gap-1 whitespace-nowrap hover:text-indigo-700",
          active ? "text-indigo-700" : "text-slate-500",
        )}
      >
        {label}
        <span className="inline-block w-2">
          {active ? (filters.sortDesc ? "↓" : "↑") : "↕"}
        </span>
      </Link>
    </th>
  );
}

function CatalogRow({
  row,
  busy,
  run,
  selected,
  toggleSelected,
}: {
  row: AdminCatalogRow;
  busy: boolean;
  run: (kind: "research" | "publish" | "archive", id: string) => void;
  selected: boolean;
  toggleSelected: (id: string) => void;
}) {
  const priceAssessment = assessPriceCompetitiveness(
    row.suggestedPriceCents ?? 0,
    row.ebayPriceCents ?? 0,
    row.averageCompetitorPriceCents,
    row.ebayRecommendedPriceCents,
  );
  return (
    <tr className="group border-t border-slate-100 align-top hover:bg-slate-50/70">
      <td className="sticky left-0 z-10 min-w-[390px] bg-white px-5 py-4 group-hover:bg-slate-50">
        <div className="flex gap-3">
          <input type="checkbox" checked={selected} onChange={() => toggleSelected(row.id)} aria-label={`Select ${row.amazonTitle}`} className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
          {row.amazonImageUrl ?? row.ebayImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.amazonImageUrl ?? row.ebayImageUrl ?? ""}
              alt=""
              className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 bg-white object-contain"
            />
          ) : (
            <div className="h-16 w-16 shrink-0 rounded-lg bg-slate-100" />
          )}
          <div className="min-w-0">
            <a
              href={row.amazonUrl}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-3 text-sm font-semibold leading-5 text-slate-900 hover:text-indigo-600"
            >
              {row.amazonTitle}
            </a>
            <p className="mt-1 text-xs text-slate-500">
              {row.asin}
            </p>
            <div className="mt-1 flex gap-1.5">
              <Badge tone={statusTone(row.status)}>{row.status.replace("_", " ")}</Badge>
              {row.isAmazonBestSeller && <Badge tone="indigo">Amazon bestseller</Badge>}
              {!row.amazonInStock && <Badge tone="red">Amazon unavailable</Badge>}
            </div>
          </div>
        </div>
      </td>
      <td className="min-w-[170px] px-4 py-4 text-sm text-slate-700">
        {row.category}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums">
        {formatCents(row.amazonPriceCents + row.amazonShippingCents)}
        <p className="mt-0.5 text-[11px] font-normal text-slate-500">
          {formatCents(row.amazonPriceCents)}
          {row.amazonShippingCents > 0
            ? ` + ${formatCents(row.amazonShippingCents)} shipping`
            : " · free shipping"}
        </p>
        <p className="mt-1 text-[10px] font-normal text-slate-400">{amazonFreshness(row.amazonRefreshedAt)}</p>
      </td>
      <td className="min-w-[300px] px-4 py-4">
        {row.ebayTitle && row.ebayUrl ? (
          <>
            <a
              href={row.ebayUrl}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-2 text-sm font-medium text-slate-800 hover:text-indigo-600"
            >
              {row.ebayTitle}
            </a>
            <div className="mt-1 flex items-center gap-1.5">
              <Badge tone={confidenceTone(row.matchConfidence)}>
                {row.matchVerdict} {row.matchConfidence}%
              </Badge>
            </div>
            {row.matchReason && (
              <p className="mt-1 line-clamp-2 text-xs text-slate-500">{row.matchReason}</p>
            )}
          </>
        ) : (
          <span className="text-sm text-slate-400">No equivalent found</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-medium tabular-nums">
        {row.ebayPriceCents === null
          ? <span className="text-slate-400">—</span>
          : formatCents(row.ebayPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.averageCompetitorPriceCents === null
          ? <span className="text-slate-400">—</span>
          : formatCents(row.averageCompetitorPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.ebayRecommendedPriceCents === null
          ? <span className="text-slate-400">—</span>
          : formatCents(row.ebayRecommendedPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold text-indigo-700">
        {row.suggestedPriceCents === null
          ? <span className="text-slate-400">—</span>
          : formatCents(row.suggestedPriceCents)}
      </td>
      <td className="min-w-[250px] px-4 py-4">
        <Badge tone={priceAssessment.tone}>{priceAssessment.label}</Badge>
        <p className="mt-1.5 text-xs leading-4 text-slate-500">
          {priceAssessment.summary}
        </p>
      </td>
      <td className="px-4 py-4 text-right"><CellValue value={row.estimatedSales30d} /></td>
      <td className="px-4 py-4 text-right"><CellValue value={row.competitorCount} /></td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.estimatedProfitCents === null
          ? <span className="text-slate-400">—</span>
          : <span className={row.estimatedProfitCents >= 0 ? "font-semibold text-emerald-700" : "text-red-600"}>
              {formatCents(row.estimatedProfitCents)}
            </span>}
      </td>
      <td className="px-4 py-4 text-right">
        <CellValue value={row.marginPct} suffix="%" />
      </td>
      <td className="px-4 py-4 text-right font-semibold tabular-nums">{row.usersListed}</td>
      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">
        {row.lastResearchedAt
          ? new Date(row.lastResearchedAt).toLocaleDateString()
          : "Not researched"}
      </td>
      <td className="sticky right-0 min-w-[150px] bg-white px-4 py-4 group-hover:bg-slate-50">
        <div className="flex flex-col gap-1.5">
          <Link
            href={`/admin/arbitrage/${encodeURIComponent(row.asin)}`}
            className="inline-flex min-h-8 items-center justify-center rounded-lg bg-indigo-50 px-2.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
          >
            View report
          </Link>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            title="Full Amazon + eBay research. Uses up to 1 Rainforest credit when the Amazon response is not cached."
            onClick={() => run("research", row.id)}
          >
            ↻ Research
          </Button>
          {row.status !== "PUBLISHED" && row.ebayItemId && (
            <Button size="sm" disabled={busy} onClick={() => run("publish", row.id)}>
              Publish to users
            </Button>
          )}
          {row.status !== "ARCHIVED" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => run("archive", row.id)}
            >
              Archive
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function AdminArbitrageManager({
  data,
  filters,
}: {
  data: AdminCatalogPage;
  filters: AdminCatalogFilters;
}) {
  const router = useRouter();
  const [amazonInput, setAmazonInput] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [scanProgress, setScanProgress] = useState<AdminScanProgress | null>(null);
  const [scanTarget, setScanTarget] = useState(50);
  const [refreshMode, setRefreshMode] = useState<AdminRefreshMode>("MARKET");
  const [refreshCount, setRefreshCount] = useState(25);
  const [refreshProgress, setRefreshProgress] = useState<AdminRefreshProgress | null>(null);
  const [liveAmazonProgress, setLiveAmazonProgress] = useState<AdminLiveAmazonProgress | null>(null);
  const [liveAmazonScope, setLiveAmazonScope] = useState<"ALL" | "SELECTED">("SELECTED");
  const [skipFreshAmazon, setSkipFreshAmazon] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const stopScanRequested = useRef(false);
  const stopRefreshRequested = useRef(false);
  const liveAmazonSavePromises = useRef<Promise<void>[]>([]);
  const liveAmazonUnavailableIds = useRef(new Set<string>());
  const liveAmazonUpdatedIds = useRef(new Set<string>());
  const liveAmazonSkippedFresh = useRef(0);
  const liveAmazonStartupTimer = useRef<number | null>(null);
  const liveAmazonRunning = liveAmazonProgress?.status === "starting" || liveAmazonProgress?.status === "running";
  const allPageSelected = data.rows.length > 0 && data.rows.every((row) => selected.has(row.id));

  useEffect(() => {
    function receiveAmazonPrice(event: Event) {
      const detail = (event as CustomEvent<{ orderIds?: string[]; unitPriceCents?: number; shippingCents?: number | null }>).detail;
      if (!detail?.orderIds?.length || !Number.isFinite(detail.unitPriceCents)) return;
      const save = (async () => {
        const result = await adminUpdateAmazonCostsFromBrowser(detail.orderIds!, detail.unitPriceCents!, detail.shippingCents ?? null);
        if ("error" in result) return;
        for (const id of result.updatedIds) liveAmazonUpdatedIds.current.add(id);
      })();
      liveAmazonSavePromises.current.push(save);
    }
    function receiveAmazonUnavailable(event: Event) {
      const detail = (event as CustomEvent<{ orderIds?: string[] }>).detail;
      if (!detail?.orderIds?.length) return;
      const save = (async () => {
        const result = await adminMarkAmazonUnavailableFromBrowser(detail.orderIds!);
        if ("error" in result) return;
        for (const id of result.updatedIds) liveAmazonUnavailableIds.current.add(id);
      })();
      liveAmazonSavePromises.current.push(save);
    }
    function receiveAmazonProgress(event: Event) {
      const detail = (event as CustomEvent<{ status?: AdminLiveAmazonProgress["status"]; total?: number; processed?: number; found?: number }>).detail;
      if (!detail?.status) return;
      if (liveAmazonStartupTimer.current !== null) {
        window.clearTimeout(liveAmazonStartupTimer.current);
        liveAmazonStartupTimer.current = null;
      }
      const next = {
        status: detail.status,
        total: detail.total ?? 0,
        processed: detail.processed ?? 0,
        found: detail.found ?? 0,
        unavailable: liveAmazonUnavailableIds.current.size,
      };
      setLiveAmazonProgress(next);
      if (detail.status === "complete") {
        void Promise.all(liveAmazonSavePromises.current).then(() => {
          const unavailable = liveAmazonUnavailableIds.current.size;
          const updated = liveAmazonUpdatedIds.current.size;
          const failed = Math.max(0, next.total - updated - unavailable);
          setLiveAmazonProgress({ ...next, unavailable });
          setNotice({
            text: `Live Amazon refresh complete: ${updated} prices updated, ${unavailable} confirmed unavailable${failed ? `, and ${failed} could not be verified` : ""}${liveAmazonSkippedFresh.current ? `. ${liveAmazonSkippedFresh.current.toLocaleString()} recently checked product${liveAmazonSkippedFresh.current === 1 ? " was" : "s were"} skipped` : ""}. No Rainforest credits used.`,
            error: failed > 0,
          });
          router.refresh();
        });
      } else if (detail.status === "cancelled") {
        setNotice({ text: `Live Amazon refresh stopped after ${detail.processed ?? 0}/${detail.total ?? 0} products. Completed updates were kept.`, error: false });
      } else if (detail.status === "error") {
        setNotice({ text: "The Chrome helper could not start the admin Amazon refresh. Reload helper v1.3.5 and try again.", error: true });
      }
    }
    document.addEventListener("sellfinity:amazon-price-found", receiveAmazonPrice);
    document.addEventListener("sellfinity:amazon-product-unavailable", receiveAmazonUnavailable);
    document.addEventListener("sellfinity:amazon-price-helper-progress", receiveAmazonProgress);
    return () => {
      if (liveAmazonStartupTimer.current !== null) window.clearTimeout(liveAmazonStartupTimer.current);
      document.removeEventListener("sellfinity:amazon-price-found", receiveAmazonPrice);
      document.removeEventListener("sellfinity:amazon-product-unavailable", receiveAmazonUnavailable);
      document.removeEventListener("sellfinity:amazon-price-helper-progress", receiveAmazonProgress);
    };
  }, [router]);

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleCurrentPage() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of data.rows) {
        if (allPageSelected) next.delete(row.id); else next.add(row.id);
      }
      return next;
    });
  }

  function startLiveAmazonRefresh() {
    if (liveAmazonScope === "SELECTED" && selected.size === 0) {
      setNotice({ text: "Select at least one catalog product or choose all catalog products.", error: true });
      return;
    }
    setNotice(null);
    setScanProgress(null);
    setRefreshProgress(null);
    startTransition(async () => {
      const prepared = await prepareAdminLiveAmazonRefresh(liveAmazonScope === "SELECTED" ? [...selected] : undefined, skipFreshAmazon);
      liveAmazonSkippedFresh.current = prepared.skippedFresh;
      if (!prepared.requests.length) {
        setNotice({ text: prepared.skippedFresh ? `Nothing to refresh. ${prepared.skippedFresh.toLocaleString()} product${prepared.skippedFresh === 1 ? " was" : "s were"} checked within the last 24 hours.` : "No eligible Amazon catalog products were found.", error: false });
        return;
      }
      if (prepared.requests.length >= 250 && !window.confirm(`This will open and check ${prepared.requests.length.toLocaleString()} unique Amazon products and may take a long time. Continue?`)) return;
      liveAmazonSavePromises.current = [];
      liveAmazonUnavailableIds.current = new Set();
      liveAmazonUpdatedIds.current = new Set();
      setLiveAmazonProgress({ status: "starting", total: prepared.requests.length, processed: 0, found: 0, unavailable: 0 });
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      liveAmazonStartupTimer.current = window.setTimeout(() => {
        setLiveAmazonProgress((current) => current?.status === "starting" ? { ...current, status: "error" } : current);
        setNotice({ text: "The Chrome helper did not respond. Reload helper v1.3.5, refresh this page, then try again.", error: true });
      }, 8_000);
      document.dispatchEvent(new CustomEvent("sellfinity:bulk-amazon-price-check", { detail: { requests: prepared.requests } }));
    });
  }

  function stopLiveAmazonRefresh() {
    document.dispatchEvent(new CustomEvent("sellfinity:stop-amazon-price-check"));
  }

  function finish(result: { ok: boolean; message: string }) {
    setNotice({ text: result.message, error: !result.ok });
    if (result.ok) router.refresh();
  }

  function addAmazon(event: FormEvent) {
    event.preventDefault();
    if (!amazonInput.trim()) return;
    setScanProgress(null);
    setRefreshProgress(null);
    setOperation("Researching the Amazon item and equivalent eBay market");
    setNotice(null);
    startTransition(async () => {
      const result = await adminAddAmazonItem(amazonInput);
      if (result.ok) setAmazonInput("");
      finish(result);
      setOperation(null);
    });
  }

  function scan() {
    const target = scanTarget;
    stopScanRequested.current = false;
    setOperation("Scanning bestseller sources and verifying profitable matches");
    setNotice(null);
    setRefreshProgress(null);
    setScanProgress({
      target,
      added: 0,
      examined: 0,
      errors: 0,
      status: "running",
      detail: "Opening the persisted bestseller queue…",
    });
    startTransition(async () => {
      let added = 0;
      let examined = 0;
      let errors = 0;
      let exhausted = false;

      while (added < target && !exhausted && !stopScanRequested.current) {
        // Keep each server checkpoint capped so large scans remain resumable
        // and comfortably inside the hosting request time limit.
        const result = await adminScanBestSellers(Math.min(100, target - added));
        if (!result.ok) {
          setNotice({ text: result.message, error: true });
          setScanProgress(null);
          setOperation(null);
          return;
        }

        added += result.added;
        examined += result.examined;
        errors += result.errors ?? 0;
        exhausted = result.exhausted;
        setScanProgress({
          target,
          added,
          examined,
          errors,
          status: result.paused ? "paused" : "running",
          detail: result.paused
            ? "A provider lookup paused. Fresh sources and eligible retries will continue automatically."
            : `Research saved · ${added} of ${target} new products added`,
        });
        setNotice({
          text: `Adding Amazon bestsellers… ${added}/${target} added from ${examined} candidates.`,
          error: false,
        });

        const needsRetry =
          result.paused ||
          (result.added === 0 && result.examined === 0 && !result.exhausted);
        if (needsRetry && !stopScanRequested.current) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          setScanProgress((current) =>
            current ? { ...current, status: "running" } : current,
          );
        }
      }

      const stopped = stopScanRequested.current;
      const text = stopped
        ? `Scan stopped safely: ${added} new products added from ${examined} candidates. The queue was saved.`
        : exhausted
          ? `Bestseller scan complete: ${added} new products added; today's available sources are exhausted.`
          : `Bestseller scan complete: all ${target} new products were added from ${examined} candidates.`;
      setNotice({ text, error: false });
      setScanProgress(null);
      router.refresh();
      setOperation(null);
    });
  }

  function stopScan() {
    stopScanRequested.current = true;
    setScanProgress((current) =>
      current
        ? {
            ...current,
            status: "paused",
            detail: "Stopping safely after the current provider lookup. Completed research is already saved.",
          }
        : current,
    );
  }

  function refreshCatalog() {
    stopRefreshRequested.current = false;
    setScanProgress(null);
    setNotice(null);
    setOperation(
      refreshMode === "MARKET"
        ? "Refreshing eBay market intelligence"
        : "Refreshing Amazon landed costs",
    );
    setRefreshProgress({
      completed: 0,
      total: refreshCount,
      succeeded: 0,
      failed: 0,
      rainforestRequests: 0,
      cacheHits: 0,
    });
    startTransition(async () => {
      let prepared: Awaited<ReturnType<typeof prepareAdminCatalogRefresh>>;
      try {
        prepared = await prepareAdminCatalogRefresh(
          refreshMode,
          refreshCount,
        );
      } catch {
        setNotice({
          text: "The refresh could not be prepared. No catalog data or API credits were changed.",
          error: true,
        });
        setRefreshProgress(null);
        setOperation(null);
        return;
      }
      const ids = prepared.ids;
      if (ids.length === 0) {
        setNotice({
          text: "No eligible catalog products are available for this refresh.",
          error: false,
        });
        setRefreshProgress(null);
        setOperation(null);
        return;
      }
      let completed = 0;
      let succeeded = 0;
      let failed = 0;
      let rainforestRequests = 0;
      let cacheHits = 0;
      setRefreshProgress((current) =>
        current ? { ...current, total: ids.length } : current,
      );
      for (
        let index = 0;
        index < ids.length && !stopRefreshRequested.current;
        index += 5
      ) {
        const checkpointIds = ids.slice(index, index + 5);
        let result: Awaited<ReturnType<typeof adminRefreshCatalogBatch>>;
        try {
          result = await adminRefreshCatalogBatch(
            prepared.mode,
            checkpointIds,
          );
        } catch {
          completed += checkpointIds.length;
          failed += checkpointIds.length;
          setRefreshProgress({
            completed,
            total: ids.length,
            succeeded,
            failed,
            rainforestRequests,
            cacheHits,
          });
          continue;
        }
        completed += result.processed;
        succeeded += result.succeeded;
        failed += result.failed;
        rainforestRequests += result.rainforestRequests;
        cacheHits += result.cacheHits;
        setRefreshProgress({
          completed,
          total: ids.length,
          succeeded,
          failed,
          rainforestRequests,
          cacheHits,
        });
      }
      const stopped = stopRefreshRequested.current;
      const creditSummary = prepared.mode === "AMAZON"
        ? `${rainforestRequests} Rainforest request${rainforestRequests === 1 ? "" : "s"} used${cacheHits ? `; ${cacheHits} cache hit${cacheHits === 1 ? "" : "s"} avoided provider calls` : ""}.`
        : "0 Rainforest credits used.";
      setNotice({
        text: stopped
          ? `Refresh stopped safely after ${completed}/${ids.length} products. ${creditSummary}`
          : `Refresh complete: ${succeeded}/${ids.length} updated${failed ? `, ${failed} failed` : ""}. ${creditSummary}`,
        error: failed > 0,
      });
      setRefreshProgress(null);
      setOperation(null);
      router.refresh();
    });
  }

  function recalculatePricing() {
    setScanProgress(null);
    setRefreshProgress(null);
    setNotice(null);
    setOperation("Recalculating competitive pricing");
    startTransition(async () => {
      const result = await adminRecalculateArbitragePricing();
      finish(result);
      setOperation(null);
    });
  }

  function stopRefresh() {
    stopRefreshRequested.current = true;
    setNotice({
      text: "Stopping after the current five-product checkpoint…",
      error: false,
    });
  }

  function run(kind: "research" | "publish" | "archive", id: string) {
    setBusyId(id);
    setScanProgress(null);
    setRefreshProgress(null);
    setOperation(
      kind === "research"
        ? "Refreshing source, match, and market intelligence"
        : kind === "publish"
          ? "Publishing the curated product to users"
          : "Archiving the product",
    );
    setNotice(null);
    startTransition(async () => {
      const result =
        kind === "research"
          ? await adminResearchItem(id)
          : kind === "publish"
            ? await adminPublishItem(id)
            : await adminArchiveItem(id);
      finish(result);
      setBusyId(null);
      setOperation(null);
    });
  }

  function urlFor(
    overrides: Partial<Record<
      | "page"
      | "q"
      | "status"
      | "category"
      | "match"
      | "source"
      | "ebayMatch"
      | "minMargin"
      | "minConfidence"
      | "qualified"
      | "sort"
      | "dir"
      | "pageSize",
      string | number
    >> = {},
  ) {
    const params = new URLSearchParams({
      page: "1",
      q: filters.query,
      status: filters.status,
      category: filters.category,
      match: filters.matchVerdict,
      source: filters.source,
      ebayMatch: filters.ebayMatch,
      minMargin: String(filters.minMargin),
      minConfidence: String(filters.minConfidence),
      qualified: filters.qualifiedOnly ? "1" : "0",
      sort: filters.sortKey,
      dir: filters.sortDesc ? "desc" : "asc",
      pageSize: String(filters.pageSize),
    });
    for (const [key, value] of Object.entries(overrides)) {
      params.set(key, String(value));
    }
    return `/admin/arbitrage?${params.toString()}`;
  }

  function sortHref(sortKey: AdminCatalogSortKey): string {
    const same = filters.sortKey === sortKey;
    return urlFor({
      sort: sortKey,
      dir: same && filters.sortDesc ? "asc" : "desc",
    });
  }

  return (
    <div
      className={cx(
        "space-y-5",
        !expanded &&
          "w-full md:relative md:left-1/2 md:w-[calc(100vw-17rem)] md:-translate-x-1/2",
      )}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Catalog products" value={data.counts.all.toLocaleString()} />
        <StatCard label="Published to users" value={data.counts.published.toLocaleString()} tone="positive" />
        <StatCard label="Pending research" value={data.counts.pending.toLocaleString()} />
        <StatCard label="Needs review" value={data.counts.noMatch.toLocaleString()} tone="negative" />
        <StatCard label="Archived" value={data.counts.archived.toLocaleString()} />
      </div>

      <Card className="overflow-hidden">
        <div className="grid gap-5 bg-gradient-to-r from-slate-950 to-indigo-950 px-6 py-5 text-white lg:grid-cols-[1fr_auto]">
          <div>
            <h2 className="text-base font-semibold">Add an Amazon bestseller</h2>
            <p className="mt-1 text-sm text-indigo-100">
              Sellfinity refreshes the exact Amazon price, finds the closest eBay equivalent,
              verifies identity, and calculates competitive profitability.
            </p>
            <form onSubmit={addAmazon} className="mt-4 flex max-w-2xl flex-col gap-2 sm:flex-row">
              <Input
                value={amazonInput}
                onChange={(event) => setAmazonInput(event.target.value)}
                placeholder="Amazon product URL or ASIN"
                className="border-white/20 bg-white text-slate-900"
              />
              <Button type="submit" disabled={pending || !amazonInput.trim()} className="shrink-0">
                Add & research
              </Button>
            </form>
          </div>
          <div className="flex flex-col justify-center gap-3">
            <div className="rounded-xl border border-white/15 bg-white/10 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-100">
                Manual catalog refresh
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <select
                  aria-label="Refresh data type"
                  value={refreshMode}
                  disabled={pending}
                  onChange={(event) =>
                    setRefreshMode(event.target.value as AdminRefreshMode)
                  }
                  className="rounded-md border border-white/20 bg-slate-900 px-2 py-1.5 text-xs text-white"
                >
                  <option value="MARKET">eBay market · 0 Amazon credits</option>
                  <option value="AMAZON">Amazon cost + shipping</option>
                </select>
                <select
                  aria-label="Products to refresh"
                  value={refreshCount}
                  disabled={pending}
                  onChange={(event) => setRefreshCount(Number(event.target.value))}
                  className="rounded-md border border-white/20 bg-slate-900 px-2 py-1.5 text-xs text-white"
                >
                  {[10, 25, 50].map((count) => (
                    <option key={count} value={count}>{count} oldest products</option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={refreshCatalog}
                  className="border-white/30 bg-white text-slate-900 hover:bg-indigo-50"
                >
                  ↻ Refresh data
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={recalculatePricing}
                  className="border-white/30 bg-white text-slate-900 hover:bg-indigo-50"
                >
                  $ Recalculate pricing
                </Button>
              </div>
              <p className="mt-2 max-w-md text-[11px] leading-4 text-indigo-100">
                {refreshMode === "MARKET"
                  ? "Refreshes demand, competition, market prices, and profit with no Rainforest calls."
                  : `Refreshes exact Amazon price and shipping for up to ${refreshCount} products. Cache hits are free; otherwise allow up to ${refreshCount} Rainforest credits. An automatic prioritized refresh also runs daily at 2:00 AM Los Angeles time before the 3:00 AM scan.`}
              </p>
            </div>
            <div className="flex gap-2">
              <select
                aria-label="Amazon bestsellers to add"
                value={scanTarget}
                disabled={pending}
                onChange={(event) => setScanTarget(Number(event.target.value))}
                className="rounded-md border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                {[50, 100, 250, 500, 1000].map((count) => (
                  <option key={count} value={count}>{count} products</option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={scan}
                className="flex-1 border-white/30 bg-white/10 text-white hover:bg-white/20"
              >
                {scanProgress ? "Adding bestsellers…" : `✦ Add ${scanTarget} bestsellers`}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden border-indigo-200 bg-gradient-to-r from-white to-indigo-50/70 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-bold text-slate-950">Live signed-in Amazon refresh</h2>
              <Badge tone="indigo">0 Rainforest credits</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Open each unique ASIN through the Chrome helper and save its current item price, shipping charge, and availability directly into the shared admin catalog.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={liveAmazonScope} disabled={pending || liveAmazonRunning} onChange={(event) => setLiveAmazonScope(event.target.value as "ALL" | "SELECTED")} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700" aria-label="Live Amazon refresh scope">
              <option value="SELECTED">Selected products ({selected.size})</option>
              <option value="ALL">All catalog products ({data.counts.all.toLocaleString()})</option>
            </select>
            <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700">
              <input type="checkbox" checked={skipFreshAmazon} disabled={pending || liveAmazonRunning} onChange={(event) => setSkipFreshAmazon(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Skip checked in last 24 hours
            </label>
            <Button type="button" disabled={pending || liveAmazonRunning || (liveAmazonScope === "SELECTED" && selected.size === 0)} onClick={startLiveAmazonRefresh}>{liveAmazonRunning ? "Checking Amazon…" : "Check live prices & shipping"}</Button>
            {liveAmazonRunning && <Button type="button" variant="danger" onClick={stopLiveAmazonRefresh}>Stop</Button>}
            <a href="/downloads/sellfinity-tracking-helper.zip?v=1.3.5" download className="text-xs font-semibold text-indigo-700 hover:underline">Chrome helper v1.3.5</a>
          </div>
        </div>
      </Card>

      {liveAmazonProgress && (
        <PremiumProgress
          title={liveAmazonProgress.status === "complete" ? "Live Amazon catalog refresh complete" : liveAmazonProgress.status === "cancelled" ? "Live Amazon catalog refresh stopped" : liveAmazonProgress.status === "error" ? "Live Amazon catalog refresh needs attention" : "Checking live Amazon catalog prices"}
          subtitle="Completed prices and shipping are saved immediately. Confirmed unavailable products are flagged; uncertain pages remain unchanged."
          percentage={liveAmazonProgress.total ? liveAmazonProgress.processed / liveAmazonProgress.total * 100 : 0}
          status={liveAmazonProgress.status === "error" ? "error" : liveAmazonProgress.status === "complete" ? "complete" : liveAmazonProgress.status === "cancelled" ? "paused" : "running"}
          stats={[
            { label: "Checked", value: `${liveAmazonProgress.processed}/${liveAmazonProgress.total}`, tone: "info" },
            { label: "Prices updated", value: liveAmazonProgress.found, tone: "success" },
            { label: "Unavailable", value: liveAmazonProgress.unavailable, tone: liveAmazonProgress.unavailable ? "warning" : "default" },
          ]}
          action={liveAmazonRunning ? <Button type="button" variant="secondary" onClick={stopLiveAmazonRefresh}>Stop refresh</Button> : null}
        />
      )}

      {operation && (
        <PremiumProgress
          title={operation}
          subtitle={
            scanProgress?.detail ??
            (refreshProgress
              ? refreshMode === "MARKET"
                ? "Refreshing eBay intelligence only · no Rainforest credits"
                : `Refreshing exact Amazon landed costs · up to ${refreshProgress.total} credits before cache savings`
              : "Completed data is saved as each provider finishes.")
          }
          percentage={
            scanProgress
              ? (scanProgress.added / scanProgress.target) * 100
              : refreshProgress
                ? (refreshProgress.completed / refreshProgress.total) * 100
                : undefined
          }
          status={scanProgress?.status ?? "running"}
          stats={scanProgress
            ? [
                { label: "Products added", value: `${scanProgress.added}/${scanProgress.target}`, tone: "success" },
                { label: "Candidates examined", value: scanProgress.examined, tone: "info" },
                { label: "Temporary failures", value: scanProgress.errors, tone: scanProgress.errors ? "warning" : "default" },
              ]
            : refreshProgress
              ? [
                  { label: "Completed", value: `${refreshProgress.completed}/${refreshProgress.total}`, tone: "info" },
                  { label: "Updated", value: refreshProgress.succeeded, tone: "success" },
                  {
                    label: refreshMode === "AMAZON" ? "Rainforest requests" : "Rainforest credits",
                    value: refreshMode === "AMAZON" ? refreshProgress.rainforestRequests : 0,
                    tone: refreshProgress.rainforestRequests ? "warning" : "success",
                  },
                  ...(refreshMode === "AMAZON"
                    ? [{ label: "Cache hits", value: refreshProgress.cacheHits, tone: "info" as const }]
                    : []),
                ]
            : [
                { label: "Amazon source", value: "checking", tone: "info" },
                { label: "eBay market", value: "matching", tone: "info" },
                { label: "Profit model", value: "calculating", tone: "success" },
              ]}
          action={
            scanProgress && scanProgress.status !== "error" ? (
              <Button type="button" variant="secondary" onClick={stopScan}>
                Stop scan
              </Button>
            ) : refreshProgress ? (
              <Button type="button" variant="secondary" onClick={stopRefresh}>
                Stop refresh
              </Button>
            ) : null
          }
        />
      )}
      {notice && (
        <div className={cx(
          "rounded-lg border px-4 py-3 text-sm",
          notice.error
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-emerald-200 bg-emerald-50 text-emerald-700",
        )}>
          {notice.text}
        </div>
      )}

      {expanded && <div className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-sm" />}
      <Card
        className={cx(
          "min-w-0 overflow-hidden",
          expanded &&
            "fixed inset-3 z-50 flex flex-col rounded-2xl border-slate-300 shadow-2xl",
        )}
      >
        <div className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">Product intelligence catalog</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Search titles, ASINs, eBay IDs, match explanations, and categories.
                Profit and margin reserve 3% for advertising.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={toggleCurrentPage}>{allPageSelected ? "Clear page selection" : "Select this page"}</Button>
              {selected.size > 0 && <Badge tone="indigo">{selected.size.toLocaleString()} selected</Badge>}
              <span className="text-xs text-slate-500">
                {data.total.toLocaleString()} results
              </span>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "↙ Exit full screen" : "↗ Expand table"}
              </Button>
            </div>
          </div>

          <form action="/admin/arbitrage" method="get" className="mt-4 space-y-3">
            <input type="hidden" name="status" value={filters.status} />
            <input type="hidden" name="sort" value={filters.sortKey} />
            <input type="hidden" name="dir" value={filters.sortDesc ? "desc" : "asc"} />
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 flex-[1_1_280px]">
                <Input
                  name="q"
                  defaultValue={filters.query}
                  placeholder="Search product, ASIN, eBay ID, category, or match reason…"
                />
              </div>
              <select
                name="category"
                defaultValue={filters.category}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm sm:max-w-[240px]"
                aria-label="Category"
              >
                <option value="ALL">All categories</option>
                {data.categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
              <Button type="submit">Search & filter</Button>
              <Link
                href="/admin/arbitrage"
                className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100"
              >
                Clear
              </Link>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
              <select
                name="match"
                defaultValue={filters.matchVerdict}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Match verdict"
              >
                <option value="ALL">Any match status</option>
                <option value="MATCH">Exact match</option>
                <option value="LIKELY">Likely match</option>
                <option value="REVIEW">Needs match review</option>
                <option value="REJECTED">Rejected match</option>
                <option value="UNVERIFIED">Unverified</option>
              </select>
              <select
                name="source"
                defaultValue={filters.source}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Catalog source"
              >
                <option value="ALL">Any catalog source</option>
                <option value="BESTSELLER">Amazon bestsellers</option>
                <option value="ADMIN">Admin-added items</option>
              </select>
              <select
                name="ebayMatch"
                defaultValue={filters.ebayMatch}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="eBay equivalent"
              >
                <option value="ALL">With or without eBay match</option>
                <option value="MATCHED">Has eBay equivalent</option>
                <option value="UNMATCHED">No eBay equivalent</option>
              </select>
              <select
                name="minMargin"
                defaultValue={String(filters.minMargin)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Minimum margin"
              >
                <option value="0">Any margin</option>
                <option value="10">Margin ≥ 10%</option>
                <option value="15">Margin ≥ 15%</option>
                <option value="20">Margin ≥ 20%</option>
                <option value="30">Margin ≥ 30%</option>
              </select>
              <select
                name="minConfidence"
                defaultValue={String(filters.minConfidence)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Minimum match confidence"
              >
                <option value="0">Any confidence</option>
                <option value="70">Confidence ≥ 70%</option>
                <option value="85">Confidence ≥ 85%</option>
                <option value="95">Confidence ≥ 95%</option>
              </select>
              <select
                name="pageSize"
                defaultValue={String(filters.pageSize)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Items per page"
              >
                <option value="25">25 per page</option>
                <option value="50">50 per page</option>
                <option value="100">100 per page</option>
              </select>
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-950 transition hover:border-emerald-300 hover:bg-emerald-50">
              <input
                type="checkbox"
                name="qualified"
                value="1"
                defaultChecked={filters.qualifiedOnly}
                className="mt-0.5 h-4 w-4 rounded border-emerald-400 text-emerald-600 focus:ring-emerald-500"
              />
              <span>
                <span className="font-semibold">Qualified opportunities only</span>
                <span className="ml-2 text-xs text-emerald-800">
                  Match or Likely · confidence ≥ 95% · competitive price · net margin ≥ 15% or about $7 profit
                </span>
              </span>
            </label>
          </form>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {statusOptions.map((option) => (
              <Link
                key={option.value}
                href={urlFor({ status: option.value })}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold",
                  filters.status === option.value
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </div>

        <div
          className={cx(
            "overflow-auto",
            expanded ? "min-h-0 flex-1" : "max-h-[72vh]",
          )}
        >
          <table className="w-full min-w-[2710px] text-sm">
            <thead className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <SortHeader label="Amazon item" sortKey="amazonTitle" filters={filters} href={sortHref("amazonTitle")} align="left" sticky="left" />
                <SortHeader label="Category" sortKey="category" filters={filters} href={sortHref("category")} align="left" />
                <SortHeader label="Amazon landed cost" sortKey="amazonPrice" filters={filters} href={sortHref("amazonPrice")} />
                <SortHeader label="Equivalent eBay item" sortKey="matchConfidence" filters={filters} href={sortHref("matchConfidence")} align="left" />
                <SortHeader label="eBay price" sortKey="ebayPrice" filters={filters} href={sortHref("ebayPrice")} />
                <SortHeader label="Competitor avg" sortKey="averagePrice" filters={filters} href={sortHref("averagePrice")} />
                <SortHeader label="eBay recommended" sortKey="recommendedPrice" filters={filters} href={sortHref("recommendedPrice")} />
                <SortHeader label="Suggested price" sortKey="suggestedPrice" filters={filters} href={sortHref("suggestedPrice")} />
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Price assessment</th>
                <SortHeader label="Sales / month" sortKey="sales" filters={filters} href={sortHref("sales")} />
                <SortHeader label="Competition" sortKey="competition" filters={filters} href={sortHref("competition")} />
                <SortHeader label="Profit after ads" sortKey="profit" filters={filters} href={sortHref("profit")} />
                <SortHeader label="Margin after ads" sortKey="margin" filters={filters} href={sortHref("margin")} />
                <SortHeader label="Users listed" sortKey="usersListed" filters={filters} href={sortHref("usersListed")} />
                <SortHeader label="Researched" sortKey="researched" filters={filters} href={sortHref("researched")} align="left" />
                <th className="sticky right-0 top-0 z-40 bg-slate-50 px-4 py-3 text-left">
                  Manage
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <CatalogRow
                  key={row.id}
                  row={row}
                  busy={pending && busyId === row.id}
                  run={run}
                  selected={selected.has(row.id)}
                  toggleSelected={toggleSelected}
                />
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && (
            <div className="px-6 py-16 text-center text-sm text-slate-500">
              No catalog products match these search filters.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-white px-5 py-3 text-sm">
          <span className="text-slate-500">
            Page {data.page} of {data.pageCount} · {data.total.toLocaleString()} matching products
          </span>
          <div className="flex gap-2">
            {data.page > 1 ? (
              <Link href={urlFor({ page: data.page - 1 })} className="rounded-lg border px-3 py-1.5 hover:bg-slate-50">
                Previous
              </Link>
            ) : <span />}
            {data.page < data.pageCount && (
              <Link href={urlFor({ page: data.page + 1 })} className="rounded-lg border px-3 py-1.5 hover:bg-slate-50">
                Next
              </Link>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
