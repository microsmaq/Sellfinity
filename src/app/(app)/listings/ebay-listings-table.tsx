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
  trueProfitCents,
} from "@/lib/listings/cleanup";
import { assessPriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { arbitrageSuggestedPriceCents } from "@/lib/arbitrage/pricing";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";
import { PremiumProgress, type PremiumProgressStatus } from "@/components/premium-progress";
import { downloadBase64File } from "@/lib/download";
import { listingNeedsAttention } from "@/lib/listings/attention";
import { assessListingHealth } from "@/lib/listings/health";
import { discountedEbayPriceCents } from "@/lib/fees";

export type EbayRow = {
  ebayListingId: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl: string | null;
  quantity: number | null;
  listingDate: string | null;
  source: {
    title: string;
    sku: string;
    imageUrl: string | null;
    category: string;
    priceCents: number;
    shippingCostCents: number;
    url: string;
    stock: number;
  } | null;
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
  | "amazonTitle"
  | "ebayTitle"
  | "category"
  | "price"
  | "listingDate"
  | "amazonPrice"
  | "profit"
  | "margin"
  | "demand"
  | "competition"
  | "recommendedPrice"
  | "averagePrice"
  | "suggestedPrice"
  | "matchConfidence"
  | "competitiveHealth";

const PRICE_CLEANUP_BATCH_SIZE = 4;

function competitiveHealthSortValue(row: EbayRow, sitewideDiscountBps = 0): number {
  const health = assessListingHealth(row, sitewideDiscountBps);
  const rank = {
    SOURCE_ISSUE: 1,
    UNPROFITABLE: 2,
    THIN_MARGIN: 3,
    MARKET_DATA_NEEDED: 4,
    ABOVE_MARKET: 5,
    COMPETITIVE: 6,
  }[health.status];
  const qualityWithinStatus =
    health.status === "ABOVE_MARKET"
      ? -(health.priceDifferencePct ?? 0) * 100
      : health.marginPct ?? health.profitCents ?? 0;
  return rank * 1_000_000 + qualityWithinStatus;
}

function currentProfit(row: EbayRow, sitewideDiscountBps = 0): { profitCents: number; marginPct: number } | null {
  if (!row.match) return null;
  const profitCents = trueProfitCents(
    row.priceCents,
    row.match.amazonPriceCents,
    row.match.shippingCostCents,
    sitewideDiscountBps,
  );
  const buyerPriceCents = discountedEbayPriceCents(row.priceCents, sitewideDiscountBps);
  const marginPct = buyerPriceCents > 0
    ? Math.round((profitCents / buyerPriceCents) * 100)
    : 0;
  return { profitCents, marginPct };
}

function formatListingDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

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

type ListingOperationProgress = {
  kind: "enhance" | "match" | "pricing" | "market";
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  detail?: string;
  status: PremiumProgressStatus;
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
      ? `${progress.recoveryQueued} ended listing${progress.recoveryQueued === 1 ? " is" : "s are"} also being checked for recovery.`
      : progress.stage === "complete"
        ? "Your refreshed listings and recovered products are ready."
        : "This page can remain open while Sellfinity works through each item.";

  return (
    <PremiumProgress
      title={title}
      subtitle={subtitle}
      percentage={percentage}
      status={progress.stage === "complete" ? "complete" : "running"}
      stats={[
        { label: "verified", value: progress.kept },
        ...(progress.freshSkipped > 0 ? [{ label: "recent checks reused", value: progress.freshSkipped, tone: "info" as const }] : []),
        { label: "sources replaced", value: progress.replaced },
        { label: "recovered & relisted", value: progress.relisted, tone: "success" },
        { label: "delisted", value: progress.ended, tone: "warning" },
        ...(progress.review > 0 ? [{ label: "need review", value: progress.review, tone: "danger" as const }] : []),
      ]}
    />
  );
}

function ListingOperationStatus({ progress }: { progress: ListingOperationProgress }) {
  const percentage = progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : progress.status === "complete" ? 100 : 4;
  const meta = {
    enhance: ["AI-enhancing selected listings", "Generating premium imagery and optimizing enabled listing content."],
    match: ["Matching listings to Amazon sources", "Comparing product identity and exact variants for each listing."],
    pricing: ["Applying profitable suggested prices", "Verifying live source costs before updating each eBay listing."],
    market: ["Refreshing market intelligence", "Updating demand, competition, market pricing, and suggested prices."],
  }[progress.kind];
  return (
    <PremiumProgress
      title={progress.status === "complete" ? `${meta[0]} complete` : meta[0]}
      subtitle={progress.detail ?? meta[1]}
      percentage={percentage}
      status={progress.status}
      stats={[
        { label: "processed", value: `${progress.completed}/${progress.total}` },
        { label: "successful", value: progress.succeeded, tone: "success" },
        ...(progress.failed > 0 ? [{ label: "need attention", value: progress.failed, tone: "danger" as const }] : []),
      ]}
    />
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
    <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">
      <button
        onClick={() => onSort(value)}
        className={cx(
          "inline-flex items-center gap-1 whitespace-nowrap hover:text-indigo-700",
          active ? "text-indigo-700" : "text-slate-500",
        )}
      >
        {label}
        <span className="inline-block w-2">
          {active ? (descending ? "↓" : "↑") : "↕"}
        </span>
      </button>
    </th>
  );
}

function RepriceCell({
  row,
  pending,
  onDraftPriceChange,
  onEditingChange,
  onReprice,
}: {
  row: EbayRow;
  pending: boolean;
  onDraftPriceChange: (priceCents: number) => void;
  onEditingChange: (editing: boolean) => void;
  onReprice: (priceCents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState((row.priceCents / 100).toFixed(2));
  const [originalPriceCents, setOriginalPriceCents] = useState(row.priceCents);

  if (!editing) {
    return (
      <button
        className="font-medium tabular-nums text-slate-900 underline decoration-dotted underline-offset-2 hover:text-indigo-600"
        onClick={() => {
          setOriginalPriceCents(row.priceCents);
          setPrice((row.priceCents / 100).toFixed(2));
          onEditingChange(true);
          setEditing(true);
        }}
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
        onChange={(e) => {
          const next = e.target.value;
          setPrice(next);
          const cents = parseDollarsToCents(next);
          if (cents !== null) onDraftPriceChange(cents);
        }}
        className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-xs tabular-nums focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
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
            onEditingChange(false);
            setEditing(false);
          }
        }}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          onDraftPriceChange(originalPriceCents);
          setPrice((originalPriceCents / 100).toFixed(2));
          onEditingChange(false);
          setEditing(false);
        }}
      >
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
  sitewideDiscountBps,
}: {
  rows: EbayRow[];
  fetchError: string | null;
  improveMainImage: boolean;
  improveListingContent: boolean;
  sitewideDiscountBps: number;
}) {
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<ListingOperationProgress | null>(null);
  const [syncProgress, setSyncProgress] = useState<ListingSyncProgress | null>(null);
  const [sortKey, setSortKey] = useState<ListingSortKey>("margin");
  const [sortDescending, setSortDescending] = useState(true);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedTable, setExpandedTable] = useState(false);
  const [lockedSortOrder, setLockedSortOrder] = useState<string[] | null>(null);

  const problems = rows.filter(listingNeedsAttention).length;
  const filteredRows = useMemo(
    () => (attentionOnly ? rows.filter(listingNeedsAttention) : rows),
    [attentionOnly, rows],
  );

  const sortedRows = useMemo(() => {
    if (lockedSortOrder) {
      const position = new Map(lockedSortOrder.map((id, index) => [id, index]));
      return [...filteredRows].sort(
        (left, right) =>
          (position.get(left.ebayListingId) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(right.ebayListingId) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    const value = (row: EbayRow): string | number | null => {
      switch (sortKey) {
        case "amazonTitle": return (row.source?.title ?? row.title).toLowerCase();
        case "ebayTitle": return row.title.toLowerCase();
        case "category": return row.source?.category.toLowerCase() ?? null;
        case "price": return row.priceCents;
        case "listingDate": return row.listingDate ? Date.parse(row.listingDate) : null;
        case "amazonPrice":
          return row.match
            ? row.match.amazonPriceCents + row.match.shippingCostCents
            : null;
        case "profit": return currentProfit(row, sitewideDiscountBps)?.profitCents ?? null;
        case "margin": return currentProfit(row, sitewideDiscountBps)?.marginPct ?? null;
        case "demand": return row.market?.estimatedSales30d ?? null;
        case "competition": return row.market?.competitorCount ?? null;
        case "recommendedPrice": return row.market?.bestSellingPriceCents ?? null;
        case "averagePrice": return row.market?.averageCompetitorPriceCents ?? null;
        case "suggestedPrice": return row.suggestedPriceCents;
        case "matchConfidence": return row.sourceAssessment?.confidence ?? null;
        case "competitiveHealth": return competitiveHealthSortValue(row, sitewideDiscountBps);
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
  }, [filteredRows, lockedSortOrder, sitewideDiscountBps, sortKey, sortDescending]);
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
    setBulkProgress({ kind: "enhance", completed: 0, total: ids.length, succeeded: 0, failed: 0, status: "running" });
    startTransition(async () => {
      let enhanced = 0;
      let failed = 0;
      let imagesEnhanced = 0;
      let copyEnhanced = 0;
      let imagesRetained = 0;
      let copyRetained = 0;
      const failureReasons = new Set<string>();
      for (let index = 0; index < ids.length; index++) {
        let result: Awaited<ReturnType<typeof enhanceEbayListing>>;
        try {
          result = await enhanceEbayListing(ids[index]);
        } catch (error) {
          const message = error instanceof Error && error.message
            ? error.message
            : "The enhancement request was interrupted before it finished.";
          result = {
            ebayListingId: ids[index],
            ok: false,
            error: message,
          };
        }
        if (result.ok) {
          enhanced++;
          if (result.imageEnhanced) imagesEnhanced++;
          else if (result.imageWarning) imagesRetained++;
          if (result.contentEnhanced) copyEnhanced++;
          else if (result.contentWarning) copyRetained++;
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
          failureReasons.add(result.error ?? "Enhancement failed");
        }
        setBulkProgress({
          kind: "enhance",
          completed: index + 1,
          total: ids.length,
          succeeded: enhanced,
          failed,
          detail: result.ok
            ? `Finished ${index + 1} of ${ids.length}. The latest listing was updated on eBay.`
            : `Finished ${index + 1} of ${ids.length}. The latest listing needs attention.`,
          status: index + 1 === ids.length ? "complete" : "running",
        });
      }
      setNotice({
        text: `AI enhancement complete: ${enhanced} listings updated · ${imagesEnhanced} images generated · ${copyEnhanced} titles/descriptions optimized${imagesRetained ? ` · ${imagesRetained} image generations failed` : ""}${copyRetained ? ` · ${copyRetained} original descriptions retained` : ""}${failed ? ` · ${failed} failed or had no tracked Amazon source` : ""}.${failureReasons.size ? ` ${[...failureReasons][0]}` : ""}`,
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
              match: {
                ...r.match,
                shippingCostCents: r.match.amazonShippingCents,
              },
              sourceAssessment: { ...r.assessment, amazonUrl: r.match.amazonUrl },
            }
          : row;
      }),
    );
  }

  function matchAll() {
    const unmatchedRows = rows.filter((r) => !r.match && !r.sourceAssessment);
    setNotice(null);
    setBulkProgress({ kind: "match", completed: 0, total: unmatchedRows.length, succeeded: 0, failed: 0, status: "running" });
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
        const completed = Math.min(i + 10, unmatchedRows.length);
        setBulkProgress({
          kind: "match",
          completed,
          total: unmatchedRows.length,
          succeeded: matched,
          failed: noMatch,
          status: completed === unmatchedRows.length ? "complete" : "running",
        });
      }
      setNotice({
        text: `Match complete: ${matched} matched, ${noMatch} without a confident Amazon match. Review the pairings — Unmatch any that look wrong.`,
        error: false,
      });
    });
  }

  function syncListingHealth() {
    if (
      !confirm(
        "Smart Sync will check sources and market prices. Ended listings may be relisted when a profitable source is available. Continue?",
      )
    ) {
      return;
    }
    setNotice(null);
    setBulkProgress(null);
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
        text: `Smart Sync complete: ${totals.kept} verified, ${totals.replaced} sources updated, ${totals.relisted} relisted, ${totals.ended} ended, and ${marketUpdated} market prices refreshed${totals.review || marketErrors ? `. ${totals.review + marketErrors} need review` : ""}.`,
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
    setBulkProgress({ kind: "pricing", completed: 0, total: items.length, succeeded: 0, failed: 0, status: "running" });
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
                  shippingCostCents:
                    r.amazonShippingCents ?? row.match.shippingCostCents,
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
        const completed = Math.min(i + PRICE_CLEANUP_BATCH_SIZE, items.length);
        setBulkProgress({
          kind: "pricing",
          completed,
          total: items.length,
          succeeded: repriced,
          failed: errors,
          status: completed === items.length ? "complete" : "running",
        });
      }
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
    setBulkProgress({ kind: "market", completed: 0, total: targets.length, succeeded: 0, failed: 0, status: "running" });
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
                    ? arbitrageSuggestedPriceCents(
                        row.match.amazonPriceCents,
                        row.priceCents,
                        result.market.bestSellingPriceCents,
                        result.market.averageCompetitorPriceCents,
                        row.match.shippingCostCents,
                        sitewideDiscountBps,
                      )
                    : null,
                }
              : {
                  ...row,
                  market: null,
                  suggestedPriceCents: row.match
                    ? arbitrageSuggestedPriceCents(
                        row.match.amazonPriceCents,
                        row.priceCents,
                        null,
                        null,
                        row.match.shippingCostCents,
                        sitewideDiscountBps,
                      )
                    : null,
                };
          }),
        );
        researched += results.filter((result) => result.market).length;
        unavailable += results.filter((result) => !result.market && !result.error).length;
        errors += results.filter((result) => result.error).length;
        const completed = Math.min(i + 10, targets.length);
        setBulkProgress({
          kind: "market",
          completed,
          total: targets.length,
          succeeded: researched,
          failed: errors,
          detail: unavailable > 0 ? `${unavailable} listings currently have no comparable market results.` : undefined,
          status: completed === targets.length ? "complete" : "running",
        });
      }
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
          listingDate: row.listingDate,
          ebayUrl: row.url,
          ebayPriceCents: row.priceCents,
          amazonUrl: row.match?.amazonUrl ?? null,
          amazonPriceCents: row.match?.amazonPriceCents ?? null,
          amazonShippingCents: row.match?.shippingCostCents ?? null,
          profitCents: currentProfit(row, sitewideDiscountBps)?.profitCents ?? null,
          marginPct: currentProfit(row, sitewideDiscountBps)?.marginPct ?? null,
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
              : (currentProfit(row, sitewideDiscountBps)?.profitCents ?? 0) <= 0
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
          {bulkProgress?.kind === "pricing" && bulkProgress.status === "running" ? "Applying prices…" : "Apply suggested prices"}
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
          {bulkProgress?.kind === "market" && bulkProgress.status === "running" ? "Refreshing market…" : "Refresh all market data"}
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
          ✨ {bulkProgress?.kind === "enhance" && bulkProgress.status === "running"
            ? `Enhancing ${bulkProgress.completed}/${bulkProgress.total}`
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
            {bulkProgress?.kind === "match" && bulkProgress.status === "running"
              ? `Matching ${bulkProgress.completed}/${bulkProgress.total}`
              : `Match all unmatched (${unmatched})`}
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

      {bulkProgress ? <ListingOperationStatus progress={bulkProgress} /> : syncProgress && <SmartSyncStatus progress={syncProgress} />}

      {fetchError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Couldn&apos;t load your eBay listings: {fetchError}
        </p>
      )}

      {expandedTable && (
        <div className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-sm" />
      )}
      <Card
        className={cx(
          "min-w-0 overflow-hidden",
          expandedTable &&
            "fixed inset-3 z-50 flex flex-col rounded-2xl border-slate-300 shadow-2xl",
        )}
      >
        <div className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">Active listing intelligence</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Live eBay listings with Amazon source, market benchmarks, match confidence, and profitability.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">
                {filteredRows.length.toLocaleString()} results
              </span>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setExpandedTable((value) => !value)}
              >
                {expandedTable ? "↙ Exit full screen" : "↗ Expand table"}
              </Button>
            </div>
          </div>
        </div>
        <div
          className={cx(
            "overflow-auto",
            expandedTable ? "min-h-0 flex-1" : "max-h-[72vh]",
          )}
        >
        <table className="w-full min-w-[3300px] text-sm">
          <thead className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="sticky left-0 top-0 z-50 w-12 bg-slate-50 px-4 py-3">
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
              <th className="sticky left-12 top-0 z-40 bg-slate-50 px-4 py-3 text-left">
                <button onClick={() => sortBy("amazonTitle")} className="hover:text-indigo-700">
                  Amazon item {sortKey === "amazonTitle" ? (sortDescending ? "↓" : "↑") : "↕"}
                </button>
              </th>
              <ListingSortHeader label="Category" value="category" active={sortKey === "category"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Amazon landed cost" value="amazonPrice" active={sortKey === "amazonPrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Equivalent eBay item" value="ebayTitle" active={sortKey === "ebayTitle"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="eBay price" value="price" active={sortKey === "price"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Competitor avg" value="averagePrice" active={sortKey === "averagePrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="eBay recommended" value="recommendedPrice" active={sortKey === "recommendedPrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Suggested price" value="suggestedPrice" active={sortKey === "suggestedPrice"} descending={sortDescending} onSort={sortBy} />
              <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Price assessment</th>
              <ListingSortHeader label="Sales / month" value="demand" active={sortKey === "demand"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Competition" value="competition" active={sortKey === "competition"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Profit after ads" value="profit" active={sortKey === "profit"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Margin after ads" value="margin" active={sortKey === "margin"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Match confidence" value="matchConfidence" active={sortKey === "matchConfidence"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Competitive health" value="competitiveHealth" active={sortKey === "competitiveHealth"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Listing date" value="listingDate" active={sortKey === "listingDate"} descending={sortDescending} onSort={sortBy} />
              <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3">Status</th>
              <th className="sticky right-0 top-0 z-40 bg-slate-50 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const problem = listingNeedsAttention(r);
              const health = assessListingHealth(r, sitewideDiscountBps);
              const profit = currentProfit(r, sitewideDiscountBps);
              const priceAssessment = assessPriceCompetitiveness(
                r.priceCents,
                r.priceCents,
                r.market?.averageCompetitorPriceCents,
                r.market?.bestSellingPriceCents,
                r.suggestedPriceCents,
                sitewideDiscountBps,
              );
              return (
                <tr
                  key={r.ebayListingId}
                  className={cx(
                    "group border-t border-slate-100 align-top hover:bg-slate-50/70",
                    problem && "bg-red-50/40",
                  )}
                >
                  <td className="sticky left-0 z-10 w-12 bg-white px-4 py-5 group-hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selected.has(r.ebayListingId)}
                      onChange={() => toggleSelected(r.ebayListingId)}
                      aria-label={`Select ${r.title}`}
                    />
                  </td>
                  <td className="sticky left-12 z-10 min-w-[390px] bg-white px-5 py-4 group-hover:bg-slate-50">
                    <div className="flex gap-3">
                      {r.source?.imageUrl || r.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.source?.imageUrl || r.imageUrl || ""}
                          alt=""
                          className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 bg-white object-contain"
                        />
                      ) : <div className="h-16 w-16 shrink-0 rounded-lg bg-slate-100" />}
                      <div className="min-w-0">
                        {r.source ? (
                          <a href={r.source.url} target="_blank" rel="noreferrer" className="line-clamp-3 text-sm font-semibold leading-5 text-slate-900 hover:text-indigo-600">
                            {r.source.title}
                          </a>
                        ) : <p className="text-sm font-semibold text-slate-500">No tracked Amazon source</p>}
                        <p className="mt-1 text-xs text-slate-500">{r.source?.sku ?? `eBay #${r.ebayListingId}`}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {r.source && <Badge tone={r.source.stock > 0 ? "green" : "red"}>{r.source.stock > 0 ? `${r.source.stock} in stock` : "Unavailable"}</Badge>}
                          {r.sourceAssessment && <Badge tone={r.sourceAssessment.confidence !== null && r.sourceAssessment.confidence >= 95 ? "green" : "amber"}>{r.sourceAssessment.verdict} {r.sourceAssessment.confidence ?? "—"}%</Badge>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="min-w-[170px] px-4 py-4 text-sm text-slate-700">{r.source?.category ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums">
                    {r.source ? <>{formatCents(r.source.priceCents + r.source.shippingCostCents)}<p className="mt-0.5 text-[11px] font-normal text-slate-500">{formatCents(r.source.priceCents)}{r.source.shippingCostCents > 0 ? ` + ${formatCents(r.source.shippingCostCents)} shipping` : " · free shipping"}</p></> : "—"}
                  </td>
                  <td className="min-w-[310px] px-4 py-4">
                    <a href={r.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-sm font-medium text-slate-800 hover:text-indigo-600">{r.title}</a>
                    <p className="mt-1 text-xs text-slate-500">#{r.ebayListingId}{r.quantity !== null && ` · ${r.quantity} available`}</p>
                    {r.sourceAssessment?.reason && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{r.sourceAssessment.reason}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-right">
                    <RepriceCell
                      row={r}
                      pending={pending}
                      onEditingChange={(editing) =>
                        setLockedSortOrder(
                          editing ? sortedRows.map((row) => row.ebayListingId) : null,
                        )
                      }
                      onDraftPriceChange={(priceCents) => setRows((prev) => prev.map((x) => x.ebayListingId === r.ebayListingId ? { ...x, priceCents } : x))}
                      onReprice={(priceCents) => run(r.ebayListingId, () => repriceEbayListing(r.ebayListingId, priceCents), () => setRows((prev) => prev.map((x) => x.ebayListingId === r.ebayListingId ? { ...x, priceCents } : x)), "Price updated on eBay.")}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums">{r.market ? formatCents(r.market.averageCompetitorPriceCents) : "—"}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums">{r.market ? <span title="Sellfinity recommendation derived from the strongest comparable eBay listing." className="font-medium text-blue-700">{formatCents(r.market.bestSellingPriceCents)}</span> : "—"}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums">
                    {r.suggestedPriceCents !== null && r.match ? (
                      <div
                        className={cx(
                          "font-medium",
                          r.market && discountedEbayPriceCents(r.suggestedPriceCents, sitewideDiscountBps) > r.market.averageCompetitorPriceCents
                            ? "text-amber-700"
                            : "text-indigo-700",
                        )}
                        title={
                          r.market && discountedEbayPriceCents(r.suggestedPriceCents, sitewideDiscountBps) > r.market.averageCompetitorPriceCents
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
                              sitewideDiscountBps,
                            ) /
                              discountedEbayPriceCents(r.suggestedPriceCents, sitewideDiscountBps)) *
                              100,
                          )}% est. margin
                        </p>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="min-w-[250px] px-4 py-4">
                    <div title={priceAssessment.summary}>
                      <Badge tone={priceAssessment.tone}>{priceAssessment.label}</Badge>
                      <p className="mt-1 max-w-[260px] text-xs leading-4 text-slate-500">
                        {priceAssessment.summary}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right tabular-nums">{r.market ? r.market.estimatedSales30d.toLocaleString() : "—"}</td>
                  <td className="px-4 py-4 text-right tabular-nums">{r.market?.competitorCount?.toLocaleString() ?? "—"}</td>
                  <td className={cx("whitespace-nowrap px-4 py-4 text-right tabular-nums", profit && (profit.profitCents > 0 ? "font-semibold text-emerald-700" : "text-red-600"))}>{profit ? formatCents(profit.profitCents) : "—"}</td>
                  <td className={cx("px-4 py-4 text-right tabular-nums", profit && (profit.marginPct >= 15 ? "font-semibold text-emerald-700" : "text-amber-700"))}>{profit ? `${profit.marginPct}%` : "—"}</td>
                  <td className="px-4 py-4 text-right">
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
                    className="px-4 py-4 text-right"
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
                    {profit !== null && (
                      <p className="whitespace-nowrap text-xs text-slate-500">
                        {formatCents(profit.profitCents)} net · {profit.marginPct}%
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-right text-xs text-slate-500" title={r.listingDate ? new Date(r.listingDate).toLocaleString("en-US") : "Listing date unavailable"}>{formatListingDate(r.listingDate)}</td>
                  <td className="px-4 py-4">
                    {!r.match && r.sourceAssessment ? (
                      <Badge tone="amber">Review source</Badge>
                    ) : !r.match ? (
                      <Badge tone="slate">Unmatched</Badge>
                    ) : r.match.unavailable ? (
                      <Badge tone="red">Not on Amazon</Badge>
                    ) : (profit?.profitCents ?? 0) <= 0 ? (
                      <Badge tone="red">Unprofitable</Badge>
                    ) : (
                      <Badge tone="green">OK</Badge>
                    )}
                  </td>
                  <td className="sticky right-0 whitespace-nowrap bg-white px-4 py-3 text-right group-hover:bg-slate-50">
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
                <td colSpan={19} className="px-4 py-12 text-center text-slate-500">
                  {attentionOnly
                    ? "No active listings currently need attention."
                    : "No active listings found on your eBay account."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
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
