"use client";

import { useMemo, useState, useTransition } from "react";
import {
  cleanupEbayListings,
  cleanupListingSourcesBatch,
  enhanceEbayListing,
  endEbayListing,
  exportEbayListings,
  matchEbayListing,
  matchEbayListingsBatch,
  repriceEbayListing,
  researchEbayListingsMarket,
  unmatchEbayListing,
  startListingHealthSync,
} from "@/lib/actions/ebay-listings";
import {
  aiSuggestedListingPriceCents,
  trueProfitCents,
} from "@/lib/listings/cleanup";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";
import { downloadBase64File } from "@/lib/download";
import { listingNeedsAttention } from "@/lib/listings/attention";
import { assessListingHealth } from "@/lib/listings/health";

export type EbayRow = {
  ebayListingId: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl: string | null;
  quantity: number | null;
  market: {
    estimatedSales30d: number;
    competitorCount: number;
    averageCompetitorPriceCents: number;
    bestSellingPriceCents: number;
  } | null;
  suggestedPriceCents: number | null;
  /** Amazon source data when this listing is matched/tracked. */
  match: {
    sku: string;
    amazonPriceCents: number;
    shippingCostCents: number;
    amazonUrl: string;
    profitCents: number;
    marginPct: number;
    unavailable: boolean;
  } | null;
  sourceAssessment: {
    verdict: string;
    confidence: number | null;
    reason: string | null;
    method: string | null;
    amazonUrl: string | null;
  } | null;
};

type ListingSortKey =
  | "title"
  | "price"
  | "amazonPrice"
  | "profit"
  | "margin"
  | "demand"
  | "competition"
  | "recommendedPrice"
  | "averagePrice"
  | "suggestedPrice"
  | "matchConfidence";

const PRICE_CLEANUP_BATCH_SIZE = 4;

type ListingSyncProgress = {
  stage: "preparing" | "sources" | "market" | "complete";
  completed: number;
  total: number;
  activeQueued: number;
  recoveryQueued: number;
  freshSkipped: number;
  kept: number;
  replaced: number;
  ended: number;
  relisted: number;
  stillUnavailable: number;
  review: number;
  marketUpdated: number;
};

function SmartSyncIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cx("h-4 w-4", spinning && "animate-spin")}
    >
      <path d="M20 7v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v-5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.1 8.5A7 7 0 0 1 18.7 7L20 12M4 12l1.3 5A7 7 0 0 0 17.9 15.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SmartSyncStatus({ progress }: { progress: ListingSyncProgress }) {
  const sourceRatio = progress.total > 0 ? progress.completed / progress.total : 1;
  const marketRatio = progress.total > 0 ? progress.completed / progress.total : 1;
  const percentage =
    progress.stage === "preparing"
      ? 3
      : progress.stage === "sources"
        ? Math.max(5, Math.round(sourceRatio * 75))
        : progress.stage === "market"
          ? 75 + Math.round(marketRatio * 24)
          : 100;
  const title =
    progress.stage === "preparing"
      ? "Preparing your inventory health scan"
      : progress.stage === "sources"
        ? `Verifying Amazon variants · ${progress.completed}/${progress.total}`
        : progress.stage === "market"
          ? `Refreshing competitive pricing · ${progress.completed}/${progress.total}`
          : "Smart inventory sync complete";
  const subtitle =
    progress.stage === "sources" && progress.recoveryQueued > 0
      ? `${progress.recoveryQueued} previously unavailable listing${progress.recoveryQueued === 1 ? " is" : "s are"} also being checked for recovery.`
      : progress.stage === "complete"
        ? "Your refreshed listings and recovered products are ready."
        : "This page can remain open while Sellfinity works through each item.";

  return (
    <Card className="relative overflow-hidden border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-5 py-4 shadow-md shadow-indigo-100/60">
      <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-violet-200/30 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-200">
          <SmartSyncIcon spinning={progress.stage !== "complete"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-900">{title}</p>
              <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
            </div>
            <span className="text-sm font-semibold tabular-nums text-indigo-700">{percentage}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-indigo-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-600 via-violet-500 to-fuchsia-500 transition-[width] duration-700 ease-out"
              style={{ width: `${percentage}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-white px-2.5 py-1 text-slate-600 shadow-sm ring-1 ring-slate-200">✓ {progress.kept} verified</span>
            {progress.freshSkipped > 0 && <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-cyan-700 ring-1 ring-cyan-200">⚡ {progress.freshSkipped} recent checks reused</span>}
            <span className="rounded-full bg-white px-2.5 py-1 text-slate-600 shadow-sm ring-1 ring-slate-200">↔ {progress.replaced} sources replaced</span>
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 ring-1 ring-emerald-200">↗ {progress.relisted} recovered &amp; relisted</span>
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 ring-1 ring-amber-200">{progress.ended} delisted · {progress.stillUnavailable} still unavailable</span>
            {progress.review > 0 && <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700 ring-1 ring-red-200">! {progress.review} need review</span>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function ListingSortHeader({
  label,
  value,
  active,
  descending,
  onSort,
}: {
  label: string;
  value: ListingSortKey;
  active: boolean;
  descending: boolean;
  onSort: (value: ListingSortKey) => void;
}) {
  return (
    <th className="px-4 py-3 text-right">
      <button onClick={() => onSort(value)} className="whitespace-nowrap hover:text-slate-900">
        {label} {active ? (descending ? "↓" : "↑") : ""}
      </button>
    </th>
  );
}

function RepriceCell({
  row,
  pending,
  onReprice,
}: {
  row: EbayRow;
  pending: boolean;
  onReprice: (priceCents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState((row.priceCents / 100).toFixed(2));

  if (!editing) {
    return (
      <button
        className="font-medium tabular-nums text-slate-900 underline decoration-dotted underline-offset-2 hover:text-indigo-600"
        onClick={() => setEditing(true)}
        title="Adjust price"
      >
        {formatCents(row.priceCents)}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className="w-20 rounded-md border border-slate-300 px-2 py-1 text-xs tabular-nums"
        aria-label="New price (dollars)"
        autoFocus
      />
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          const cents = parseDollarsToCents(price);
          if (cents !== null) {
            onReprice(cents);
            setEditing(false);
          }
        }}
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </span>
  );
}

export function EbayListingsTable({
  rows: initialRows,
  fetchError,
  improveMainImage,
  improveListingContent,
}: {
  rows: EbayRow[];
  fetchError: string | null;
  improveMainImage: boolean;
  improveListingContent: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<ListingSyncProgress | null>(null);
  const [sortKey, setSortKey] = useState<ListingSortKey>("margin");
  const [sortDescending, setSortDescending] = useState(true);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const problems = rows.filter(listingNeedsAttention).length;
  const filteredRows = useMemo(
    () => (attentionOnly ? rows.filter(listingNeedsAttention) : rows),
    [attentionOnly, rows],
  );

  const sortedRows = useMemo(() => {
    const value = (row: EbayRow): string | number | null => {
      switch (sortKey) {
        case "title": return row.title.toLowerCase();
        case "price": return row.priceCents;
        case "amazonPrice": return row.match?.amazonPriceCents ?? null;
        case "profit": return row.match?.profitCents ?? null;
        case "margin": return row.match?.marginPct ?? null;
        case "demand": return row.market?.estimatedSales30d ?? null;
        case "competition": return row.market?.competitorCount ?? null;
        case "recommendedPrice": return row.market?.bestSellingPriceCents ?? null;
        case "averagePrice": return row.market?.averageCompetitorPriceCents ?? null;
        case "suggestedPrice": return row.suggestedPriceCents;
        case "matchConfidence": return row.sourceAssessment?.confidence ?? null;
      }
    };
    return [...filteredRows].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      const comparison =
        typeof a === "string" && typeof b === "string"
          ? a.localeCompare(b)
          : Number(a) - Number(b);
      return sortDescending ? -comparison : comparison;
    });
  }, [filteredRows, sortKey, sortDescending]);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = sortedRows.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const visibleIds = visibleRows.map((row) => row.ebayListingId);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function enhanceSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setNotice(null);
    startTransition(async () => {
      let enhanced = 0;
      let failed = 0;
      let warnings = 0;
      for (let index = 0; index < ids.length; index++) {
        setBulkProgress(`AI enhancing… ${index + 1}/${ids.length}`);
        const result = await enhanceEbayListing(ids[index]);
        if (result.ok) {
          enhanced++;
          if (result.warning) warnings++;
          setRows((current) =>
            current.map((row) =>
              row.ebayListingId === result.ebayListingId
                ? {
                    ...row,
                    title: result.title ?? row.title,
                    imageUrl: result.imageUrl ?? row.imageUrl,
                  }
                : row,
            ),
          );
          setSelected((current) => {
            const next = new Set(current);
            next.delete(result.ebayListingId);
            return next;
          });
        } else {
          failed++;
        }
      }
      setBulkProgress(null);
      setNotice({
        text: `AI enhancement complete: ${enhanced} updated${warnings ? `, ${warnings} used a safe partial enhancement` : ""}${failed ? `, ${failed} failed or had no tracked Amazon source` : ""}.`,
        error: failed > 0,
      });
    });
  }

  function sortBy(next: ListingSortKey) {
    if (next === sortKey) setSortDescending((current) => !current);
    else {
      setSortKey(next);
      setSortDescending(true);
    }
    setPage(1);
  }

  function applyTrackResults(results: Awaited<ReturnType<typeof matchEbayListingsBatch>>) {
    setRows((prev) =>
      prev.map((row) => {
        const r = results.find((x) => x.ebayListingId === row.ebayListingId);
        return r && r.ok
          ? {
              ...row,
              match: { ...r.match, shippingCostCents: 0 },
              sourceAssessment: { ...r.assessment, amazonUrl: r.match.amazonUrl },
            }
          : row;
      }),
    );
  }

  function matchAll() {
    const unmatchedRows = rows.filter((r) => !r.match && !r.sourceAssessment);
    setNotice(null);
    startTransition(async () => {
      let matched = 0;
      let noMatch = 0;
      for (let i = 0; i < unmatchedRows.length; i += 10) {
        const batch = unmatchedRows.slice(i, i + 10).map((r) => ({
          ebayListingId: r.ebayListingId,
          title: r.title,
          priceCents: r.priceCents,
          imageUrl: r.imageUrl,
          quantity: r.quantity,
        }));
        const results = await matchEbayListingsBatch(batch);
        applyTrackResults(results);
        matched += results.filter((x) => x.ok).length;
        noMatch += results.filter((x) => !x.ok).length;
        setBulkProgress(
          `Matching… ${Math.min(i + 10, unmatchedRows.length)}/${unmatchedRows.length} processed (${matched} matched, ${noMatch} no match)`,
        );
      }
      setBulkProgress(null);
      setNotice({
        text: `Match complete: ${matched} matched, ${noMatch} without a confident Amazon match. Review the pairings — Unmatch any that look wrong.`,
        error: false,
      });
    });
  }

  function syncListingHealth() {
    if (
      !confirm(
        "Sellfinity will verify tracked eBay listings whose Amazon check is stale, reuse recent paid-provider results, look for an approved replacement when needed, and refresh competitor pricing. Listings previously delisted by this sync because their source was unavailable are retried at most once per day and safely relisted when a profitable equivalent source is found. Manually ended listings are never relisted. If no fulfillable equivalent Amazon variant can be found, an active eBay listing will be ended so you cannot receive an order you cannot fulfill. Temporary provider failures remain active for review.\n\nContinue?",
      )
    ) {
      return;
    }
    setNotice(null);
    setSyncProgress({
      stage: "preparing",
      completed: 0,
      total: 0,
      activeQueued: 0,
      recoveryQueued: 0,
      freshSkipped: 0,
      kept: 0,
      replaced: 0,
      ended: 0,
      relisted: 0,
      stillUnavailable: 0,
      review: 0,
      marketUpdated: 0,
    });
    startTransition(async () => {
      const totals = { processed: 0, kept: 0, replaced: 0, ended: 0, relisted: 0, stillUnavailable: 0, review: 0 };
      const endedIds = new Set<string>();
      const started = await startListingHealthSync();
      setSyncProgress({
        stage: "sources",
        completed: 0,
        total: started.queued,
        activeQueued: started.activeQueued,
        recoveryQueued: started.recoveryQueued,
        freshSkipped: started.freshSkipped,
        kept: 0,
        replaced: 0,
        ended: 0,
        relisted: 0,
        stillUnavailable: 0,
        review: 0,
        marketUpdated: 0,
      });
      async function worker() {
        while (true) {
          const result = await cleanupListingSourcesBatch();
          if (result.processed === 0) break;
          totals.processed += result.processed;
          totals.kept += result.kept;
          totals.replaced += result.replaced;
          totals.ended += result.ended;
          totals.relisted += result.relisted;
          totals.stillUnavailable += result.stillUnavailable;
          totals.review += result.review;
          result.endedIds.forEach((id) => endedIds.add(id));
          if (result.endedIds.length > 0) {
            const ended = new Set(result.endedIds);
            setRows((current) => current.filter((row) => !ended.has(row.ebayListingId)));
          }
          setSyncProgress({
            stage: "sources",
            completed: totals.processed,
            total: started.queued,
            activeQueued: started.activeQueued,
            recoveryQueued: started.recoveryQueued,
            freshSkipped: started.freshSkipped,
            kept: totals.kept,
            replaced: totals.replaced,
            ended: totals.ended,
            relisted: totals.relisted,
            stillUnavailable: totals.stillUnavailable,
            review: totals.review,
            marketUpdated: 0,
          });
        }
      }
      await Promise.all(Array.from({ length: 4 }, () => worker()));

      const marketRows = rows.filter(
        (row) => !endedIds.has(row.ebayListingId),
      );
      let marketUpdated = 0;
      let marketErrors = 0;
      setSyncProgress((current) => current && ({ ...current, stage: "market", completed: 0, total: marketRows.length }));
      for (let i = 0; i < marketRows.length; i += 10) {
        const results = await researchEbayListingsMarket(
          marketRows.slice(i, i + 10).map((row) => ({
            ebayListingId: row.ebayListingId,
            title: row.title,
          })),
        );
        marketUpdated += results.filter((result) => result.market).length;
        marketErrors += results.filter((result) => result.error).length;
        setSyncProgress((current) => current && ({
          ...current,
          stage: "market",
          completed: Math.min(i + 10, marketRows.length),
          total: marketRows.length,
          marketUpdated,
        }));
      }
      setNotice({
        text: `Smart listing sync complete: ${totals.kept} sources verified, ${started.freshSkipped} recent Amazon checks reused, ${totals.replaced} replaced, ${totals.relisted} recovered and relisted, ${totals.ended} delisted without a fulfillable source, ${totals.stillUnavailable} recovery candidates remain unavailable, and ${marketUpdated} competitor prices refreshed${totals.review ? `, ${totals.review} need review` : ""}${marketErrors ? `, ${marketErrors} market lookups failed` : ""}.`,
        error: totals.review > 0 || marketErrors > 0,
      });
      setSyncProgress((current) => current && ({ ...current, stage: "complete", completed: current.total }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      window.location.reload();
    });
  }

  function cleanUp() {
    const toReprice = rows.filter((row) => row.match);
    if (toReprice.length === 0) {
      setNotice({ text: "Nothing to clean up — every matched listing is already at its profitable suggested price.", error: false });
      return;
    }
    if (
      !confirm(
        `Sellfinity will verify the exact Amazon child variant and its live price for ${toReprice.length} listing${toReprice.length === 1 ? "" : "s"}, then apply the AI suggested price. Pricing targets a 20% margin and may move as low as 15% to stay close to the eBay market recommendation and at or below the average competitor price. It never prices below 15% estimated margin after fees and the assumed 3% ad rate.\n\nNo listings will be ended. Continue?`,
      )
    ) {
      return;
    }
    const items = toReprice.map((row) => ({
      ebayListingId: row.ebayListingId,
      ebayRecommendedPriceCents: row.market?.bestSellingPriceCents,
      averageCompetitorPriceCents: row.market?.averageCompetitorPriceCents,
    }));
    setNotice(null);
    startTransition(async () => {
      let repriced = 0, errors = 0;
      for (let i = 0; i < items.length; i += PRICE_CLEANUP_BATCH_SIZE) {
        const results = await cleanupEbayListings(
          items.slice(i, i + PRICE_CLEANUP_BATCH_SIZE),
        );
        setRows((prev) =>
          prev.flatMap((row) => {
            const r = results.find((x) => x.ebayListingId === row.ebayListingId);
            if (!r) return [row];
            if ((r.action === "repriced" || r.action === "ok") && row.match) {
              return [{
                ...row,
                priceCents: r.newPriceCents ?? row.priceCents,
                suggestedPriceCents: r.suggestedPriceCents ?? row.suggestedPriceCents,
                match: {
                  ...row.match,
                  sku: r.sku ?? row.match.sku,
                  amazonPriceCents: r.amazonPriceCents ?? row.match.amazonPriceCents,
                  amazonUrl: r.amazonUrl ?? row.match.amazonUrl,
                  profitCents: r.profitCents ?? row.match.profitCents,
                  marginPct: r.marginPct ?? row.match.marginPct,
                },
              }];
            }
            return [row];
          }),
        );
        for (const r of results) {
          if (r.action === "repriced") repriced++;
          else if (r.action === "error") errors++;
        }
        setBulkProgress(`Cleaning up… ${Math.min(i + PRICE_CLEANUP_BATCH_SIZE, items.length)}/${items.length} (${repriced} adjusted)`);
      }
      setBulkProgress(null);
      setNotice({
        text: `Clean-up complete: ${repriced} adjusted to profitable suggested prices${errors ? `, ${errors} failed` : ""}.`,
        error: errors > 0,
      });
    });
  }

  function researchMarket() {
    const targets = rows;
    if (targets.length === 0) {
      setNotice({ text: "There are no active listings to research.", error: false });
      return;
    }
    setNotice(null);
    startTransition(async () => {
      let researched = 0;
      let unavailable = 0;
      let errors = 0;
      for (let i = 0; i < targets.length; i += 10) {
        const batch = targets.slice(i, i + 10).map((row) => ({
          ebayListingId: row.ebayListingId,
          title: row.title,
        }));
        const results = await researchEbayListingsMarket(batch);
        setRows((previous) =>
          previous.map((row) => {
            const result = results.find(
              (item) => item.ebayListingId === row.ebayListingId,
            );
            if (!result || result.error) return row;
            return result.market
              ? {
                  ...row,
                  market: result.market,
                  suggestedPriceCents: row.match
                    ? aiSuggestedListingPriceCents(
                        row.match.amazonPriceCents,
                        row.match.shippingCostCents,
                        result.market.bestSellingPriceCents,
                        result.market.averageCompetitorPriceCents,
                      )
                    : null,
                }
              : {
                  ...row,
                  market: null,
                  suggestedPriceCents: row.match
                    ? aiSuggestedListingPriceCents(
                        row.match.amazonPriceCents,
                        row.match.shippingCostCents,
                      )
                    : null,
                };
          }),
        );
        researched += results.filter((result) => result.market).length;
        unavailable += results.filter((result) => !result.market && !result.error).length;
        errors += results.filter((result) => result.error).length;
        setBulkProgress(
          `Refreshing all market data… ${Math.min(i + 10, targets.length)}/${targets.length} (${researched} updated)`,
        );
      }
      setBulkProgress(null);
      setNotice({
        text: `Full market refresh complete: ${researched} listings updated with current recommendation, demand, competition, average price, and AI suggested price${unavailable ? `, ${unavailable} without comparable results` : ""}${errors ? `, ${errors} failed` : ""}.`,
        error: errors > 0,
      });
    });
  }

  function exportExcel() {
    setNotice(null);
    startTransition(async () => {
      const file = await exportEbayListings(
        sortedRows.map((row) => ({
          title: row.title,
          ebayListingId: row.ebayListingId,
          ebayUrl: row.url,
          ebayPriceCents: row.priceCents,
          amazonUrl: row.match?.amazonUrl ?? null,
          amazonPriceCents: row.match?.amazonPriceCents ?? null,
          profitCents: row.match?.profitCents ?? null,
          marginPct: row.match?.marginPct ?? null,
          estimatedSales30d: row.market?.estimatedSales30d ?? null,
          competitorCount: row.market?.competitorCount ?? null,
          ebayRecommendedPriceCents: row.market?.bestSellingPriceCents ?? null,
          averageCompetitorPriceCents:
            row.market?.averageCompetitorPriceCents ?? null,
          suggestedPriceCents: row.suggestedPriceCents,
          matchVerdict: row.sourceAssessment?.verdict ?? null,
          matchConfidence: row.sourceAssessment?.confidence ?? null,
          matchReason: row.sourceAssessment?.reason ?? null,
          status: !row.match
            ? "Unmatched"
            : row.match.unavailable
              ? "Not on Amazon"
              : row.match.profitCents <= 0
                ? "Unprofitable"
                : "OK",
        })),
      );
      downloadBase64File(
        file.filename,
        file.base64,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      setNotice({ text: `Exported ${sortedRows.length} listings to Excel.`, error: false });
    });
  }

  function run(id: string, fn: () => Promise<{ error?: string }>, onOk: () => void, okText: string) {
    setNotice(null);
    setBusyId(id);
    startTransition(async () => {
      const result = await fn();
      setBusyId(null);
      if (result.error) setNotice({ text: result.error, error: true });
      else {
        onOk();
        setNotice({ text: okText, error: false });
      }
    });
  }

  const unmatched = rows.filter((r) => !r.match && !r.sourceAssessment).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
        <span>{rows.length} active on eBay</span>
        {(problems > 0 || attentionOnly) && (
          <button
            type="button"
            aria-pressed={attentionOnly}
            aria-label={
              attentionOnly
                ? "Show all active eBay listings"
                : "Show only listings that need attention"
            }
            onClick={() => {
              setAttentionOnly((current) => !current);
              setPage(1);
            }}
            className={cx(
              "rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2",
              attentionOnly && "ring-2 ring-red-500 ring-offset-1",
            )}
          >
            <Badge tone="red">
              {attentionOnly
                ? `Showing ${problems} need attention · Show all`
                : `${problems} need attention`}
            </Badge>
          </button>
        )}
        <Button size="sm" variant="secondary" disabled={pending} onClick={cleanUp}>
          {bulkProgress?.startsWith("Cleaning") ? bulkProgress : "Apply suggested prices"}
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={syncListingHealth}
          className="border-0 bg-gradient-to-r from-indigo-600 to-violet-600 px-3.5 text-white shadow-md shadow-indigo-200 hover:from-indigo-500 hover:to-violet-500 disabled:from-indigo-300 disabled:to-violet-300"
        >
          <SmartSyncIcon spinning={syncProgress !== null && syncProgress.stage !== "complete"} />
          {syncProgress && syncProgress.stage !== "complete" ? "Smart sync running" : "Smart Listing Sync"}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={researchMarket}>
          {bulkProgress?.startsWith("Refreshing all") ? bulkProgress : "Refresh all market data"}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={exportExcel}>
          Export Excel
        </Button>
        <Button
          size="sm"
          disabled={pending || selected.size === 0 || (!improveMainImage && !improveListingContent)}
          onClick={enhanceSelected}
          title={
            !improveMainImage && !improveListingContent
              ? "Enable an AI listing enhancement preference in Settings first"
              : "Apply your Settings preferences to selected listings"
          }
          className="border-0 bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-sm hover:from-violet-500 hover:to-fuchsia-500"
        >
          ✨ {bulkProgress?.startsWith("AI enhancing")
            ? bulkProgress
            : `AI enhance selected (${selected.size})`}
        </Button>
        <select
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          aria-label="Items per page"
        >
          <option value={25}>25 per page</option>
          <option value={50}>50 per page</option>
          <option value={100}>100 per page</option>
        </select>
        {unmatched > 0 && (
          <Button size="sm" disabled={pending} onClick={matchAll}>
            {bulkProgress ?? `Match all unmatched (${unmatched})`}
          </Button>
        )}
        {notice && (
          <span
            className={cx(
              "rounded-lg px-3 py-1.5",
              notice.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
            )}
          >
            {notice.text}
          </span>
        )}
      </div>

      {syncProgress && <SmartSyncStatus progress={syncProgress} />}

      {fetchError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Couldn&apos;t load your eBay listings: {fetchError}
        </p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
                      else visibleIds.forEach((id) => next.add(id));
                      return next;
                    })
                  }
                  aria-label="Select all listings on this page"
                />
              </th>
              <th className="px-4 py-3">
                <button onClick={() => sortBy("title")} className="hover:text-slate-900">
                  Listing {sortKey === "title" ? (sortDescending ? "↓" : "↑") : ""}
                </button>
              </th>
              <ListingSortHeader label="My price" value="price" active={sortKey === "price"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Amazon price" value="amazonPrice" active={sortKey === "amazonPrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Profit / Margin" value="margin" active={sortKey === "margin"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Est. demand" value="demand" active={sortKey === "demand"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Competition" value="competition" active={sortKey === "competition"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="eBay market rec." value="recommendedPrice" active={sortKey === "recommendedPrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Avg. comp price" value="averagePrice" active={sortKey === "averagePrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="AI suggested price" value="suggestedPrice" active={sortKey === "suggestedPrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Match confidence" value="matchConfidence" active={sortKey === "matchConfidence"} descending={sortDescending} onSort={sortBy} />
              <th className="px-4 py-3 text-right">Competitive health</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const problem = listingNeedsAttention(r);
              const health = assessListingHealth(r);
              return (
                <tr
                  key={r.ebayListingId}
                  className={cx(
                    "border-b border-slate-100 last:border-0",
                    problem && "bg-red-50/40",
                  )}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.ebayListingId)}
                      onChange={() => toggleSelected(r.ebayListingId)}
                      aria-label={`Select ${r.title}`}
                    />
                  </td>
                  <td className="max-w-md px-4 py-3">
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
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate font-medium text-slate-900 hover:text-indigo-600"
                          title={r.title}
                        >
                          {r.title}
                        </a>
                        <p className="text-xs text-slate-500">
                          #{r.ebayListingId}
                          {r.quantity !== null && ` · ${r.quantity} available`}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RepriceCell
                      row={r}
                      pending={pending}
                      onReprice={(priceCents) =>
                        run(
                          r.ebayListingId,
                          () => repriceEbayListing(r.ebayListingId, priceCents),
                          () =>
                            setRows((prev) =>
                              prev.map((x) =>
                                x.ebayListingId === r.ebayListingId
                                  ? { ...x, priceCents }
                                  : x,
                              ),
                            ),
                          "Price updated on eBay.",
                        )
                      }
                    />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.match ? (
                      <a
                        href={r.match.amazonUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-600 hover:underline"
                      >
                        {formatCents(r.match.amazonPriceCents)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td
                    className={cx(
                      "px-4 py-3 text-right font-medium tabular-nums",
                      r.match &&
                        (r.match.profitCents > 0 ? "text-emerald-600" : "text-red-600"),
                    )}
                  >
                    {r.match
                      ? `${formatCents(r.match.profitCents)} (${r.match.marginPct}%)`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.market ? `~${r.market.estimatedSales30d}/mo` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.market?.competitorCount ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.market ? (
                      <span
                        title="Sellfinity recommendation derived from the comparable listing with the strongest estimated demand in current eBay market data; it is not an official eBay Seller Hub recommendation."
                        className="font-medium text-blue-700"
                      >
                        {formatCents(r.market.bestSellingPriceCents)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.market
                      ? formatCents(r.market.averageCompetitorPriceCents)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.suggestedPriceCents !== null && r.match ? (
                      <div
                        className={cx(
                          "font-medium",
                          r.market && r.suggestedPriceCents > r.market.averageCompetitorPriceCents
                            ? "text-amber-700"
                            : "text-indigo-700",
                        )}
                        title={
                          r.market && r.suggestedPriceCents > r.market.averageCompetitorPriceCents
                            ? "The market average is too low to preserve the hard 15% estimated margin floor."
                            : "Closest competitive price that targets 20% margin and never falls below 15%."
                        }
                      >
                        {formatCents(r.suggestedPriceCents)}
                        <p className="mt-0.5 whitespace-nowrap text-[10px] font-normal text-slate-500">
                          {Math.round(
                            (trueProfitCents(
                              r.suggestedPriceCents,
                              r.match.amazonPriceCents,
                              r.match.shippingCostCents,
                            ) /
                              r.suggestedPriceCents) *
                              100,
                          )}% est. margin
                        </p>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.sourceAssessment ? (
                      <div title={r.sourceAssessment.reason ?? "No verification reason recorded."}>
                        <Badge
                          tone={
                            r.sourceAssessment.verdict === "MATCH" ||
                            r.sourceAssessment.verdict === "LIKELY"
                              ? "green"
                              : r.sourceAssessment.verdict === "REJECTED"
                                ? "red"
                                : "amber"
                          }
                        >
                          {r.sourceAssessment.verdict === "UNVERIFIED"
                            ? "Not checked"
                            : `${r.sourceAssessment.verdict.toLowerCase()} ${r.sourceAssessment.confidence ?? "—"}%`}
                        </Badge>
                        {r.sourceAssessment.amazonUrl && (
                          <a
                            href={r.sourceAssessment.amazonUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block text-xs text-indigo-600 hover:underline"
                          >
                            Amazon candidate ↗
                          </a>
                        )}
                      </div>
                    ) : (
                      <Badge tone="slate">Untracked</Badge>
                    )}
                  </td>
                  <td
                    className="px-4 py-3 text-right"
                    title="Profit includes estimated eBay fees, the Amazon cost, shipping cost, and a 3% promoted-listing rate."
                  >
                    <Badge
                      tone={
                        health.status === "COMPETITIVE"
                          ? "green"
                          : health.status === "SOURCE_ISSUE" ||
                              health.status === "UNPROFITABLE"
                            ? "red"
                            : "amber"
                      }
                    >
                      {health.label}
                    </Badge>
                    {health.benchmarkPriceCents !== null && (
                      <p className="mt-1 whitespace-nowrap text-xs text-slate-500">
                        eBay market rec. {formatCents(health.benchmarkPriceCents)}
                      </p>
                    )}
                    {health.profitCents !== null && (
                      <p className="whitespace-nowrap text-xs text-slate-500">
                        {formatCents(health.profitCents)} net · {health.marginPct}%
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {!r.match && r.sourceAssessment ? (
                      <Badge tone="amber">Review source</Badge>
                    ) : !r.match ? (
                      <Badge tone="slate">Unmatched</Badge>
                    ) : r.match.unavailable ? (
                      <Badge tone="red">Not on Amazon</Badge>
                    ) : r.match.profitCents <= 0 ? (
                      <Badge tone="red">Unprofitable</Badge>
                    ) : (
                      <Badge tone="green">OK</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {!r.match && !r.sourceAssessment ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() => {
                          setNotice(null);
                          setBusyId(r.ebayListingId);
                          startTransition(async () => {
                            const result = await matchEbayListing({
                              ebayListingId: r.ebayListingId,
                              title: r.title,
                              priceCents: r.priceCents,
                              imageUrl: r.imageUrl,
                              quantity: r.quantity,
                            });
                            setBusyId(null);
                            if (result.ok) applyTrackResults([result]);
                            else setNotice({ text: result.error, error: true });
                          });
                        }}
                      >
                        {busyId === r.ebayListingId ? "Matching…" : "Find Amazon match"}
                      </Button>
                    ) : r.match ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        title="Wrong product? Stop tracking this pairing"
                        onClick={() =>
                          run(
                            r.ebayListingId,
                            () => unmatchEbayListing(r.ebayListingId),
                            () =>
                              setRows((prev) =>
                                prev.map((x) =>
                                  x.ebayListingId === r.ebayListingId
                                    ? { ...x, match: null, sourceAssessment: null }
                                    : x,
                                ),
                              ),
                            "Unmatched.",
                          )
                        }
                      >
                        Unmatch
                      </Button>
                    ) : (
                      <Badge tone="amber">Review source</Badge>
                    )}{" "}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      onClick={() => {
                        if (!confirm(`End "${r.title.slice(0, 50)}…" on eBay?`)) return;
                        run(
                          r.ebayListingId,
                          () => endEbayListing(r.ebayListingId),
                          () =>
                            setRows((prev) =>
                              prev.filter((x) => x.ebayListingId !== r.ebayListingId),
                            ),
                          "Listing ended on eBay.",
                        );
                      }}
                    >
                      {busyId === r.ebayListingId ? "Working…" : "End"}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && !fetchError && (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-slate-500">
                  {attentionOnly
                    ? "No active listings currently need attention."
                    : "No active listings found on your eBay account."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <div className="flex items-center justify-center gap-4 text-sm">
        <Button variant="secondary" size="sm" disabled={currentPage <= 1} onClick={() => setPage((current) => current - 1)}>
          ← Previous
        </Button>
        <span className="text-slate-500">Page {currentPage} of {pageCount}</span>
        <Button variant="secondary" size="sm" disabled={currentPage >= pageCount} onClick={() => setPage((current) => current + 1)}>
          Next →
        </Button>
      </div>
    </div>
  );
}
