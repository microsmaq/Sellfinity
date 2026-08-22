"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  cleanupEbayListings,
  applyTargetProfitPrice,
  cleanupListingSourcesBatch,
  enhanceEbayListing,
  endEbayListing,
  exportEbayListings,
  matchEbayListing,
  matchEbayListingsBatch,
  repriceEbayListing,
  recordSuggestedPriceActivity,
  unmatchEbayListing,
  startListingHealthSync,
} from "@/lib/actions/ebay-listings";
import type { CleanupItemResult } from "@/lib/actions/ebay-listings";
import {
  trueProfitCents,
} from "@/lib/listings/cleanup";
import { trueProfitWithBuyerShippingCents } from "@/lib/listings/shipping-strategy";
import { assessPriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";
import { PremiumProgress, type PremiumProgressStatus } from "@/components/premium-progress";
import { downloadBase64File } from "@/lib/download";
import { listingNeedsAttention } from "@/lib/listings/attention";
import { assessListingHealth } from "@/lib/listings/health";
import { discountedEbayPriceCents } from "@/lib/fees";
import { isSuggestedPriceCandidate } from "@/lib/listings/suggested-price-candidate";

export type EbayRow = {
  ebayListingId: string;
  title: string;
  priceCents: number;
  shippingStrategy: string | null;
  buyerShippingCents: number | null;
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
  suggestedBuyerShippingCents: number | null;
  marketUpdatedAt?: string | null;
  performance?: {
    units7d: number;
    units30d: number;
    profit7dCents: number;
    profit30dCents: number;
  } | null;
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
  verifiedWinner?: {
    profitableUnits: number;
    profitableSaleDays: number;
    lastProfitableSaleAt: string | null;
    protectedUntil: string | null;
  } | null;
  priceLocked?: {
    lastProfitableSaleAt: string | null;
    protectedUntil: string | null;
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
  | "competitiveHealth"
  | "sales7d"
  | "profit30d";

const PRICE_CLEANUP_BATCH_SIZE = 1;

function pricingErrorLabel(message: string | undefined): string {
  if (!message) return "The pricing request did not finish";
  if (message.includes("admin-stored Amazon price")) {
    return "Admin pricing data is not available for this ASIN";
  }
  if (message.includes("admin catalog currently marks")) {
    return "The admin catalog marks this source out of stock";
  }
  if (message.includes("Exact Amazon variant")) {
    return "Amazon could not confirm the exact linked variant";
  }
  if (message.includes("Rainforest") || message.includes("Amazon child-variant")) {
    return "Amazon live pricing was temporarily unavailable";
  }
  if (message.includes("timed out") || message.includes("Timeout")) {
    return "The live-price check timed out";
  }
  if (message.includes("eBay") || message.includes("API_")) {
    return "eBay rejected the price update";
  }
  if (message === "Not tracked/active") return "The listing is no longer active";
  return message.length > 90 ? `${message.slice(0, 87)}...` : message;
}

function pricingErrorSummary(reasons: Map<string, number>): string | undefined {
  if (reasons.size === 0) return undefined;
  return [...reasons.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([reason, count]) => `${count} ${count === 1 ? "item" : "items"}: ${reason}`)
    .join(" · ");
}

function competitiveHealthSortValue(row: EbayRow, sitewideDiscountBps = 0, adRateBps = 300): number {
  const health = assessListingHealth(row, sitewideDiscountBps, adRateBps);
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

function currentProfit(row: EbayRow, sitewideDiscountBps = 0, adRateBps = 300): { profitCents: number; marginPct: number } | null {
  if (!row.match) return null;
  const profitCents = trueProfitWithBuyerShippingCents(
    row.priceCents,
    row.buyerShippingCents ?? 0,
    row.match.amazonPriceCents,
    row.match.shippingCostCents,
    sitewideDiscountBps,
    adRateBps,
  );
  const buyerPriceCents = discountedEbayPriceCents(row.priceCents, sitewideDiscountBps) + (row.buyerShippingCents ?? 0);
  const marginPct = buyerPriceCents > 0
    ? Math.round((profitCents / buyerPriceCents) * 100)
    : 0;
  return { profitCents, marginPct };
}

function canApplySuggestedPrice(row: EbayRow, sitewideDiscountBps: number, adRateBps: number): boolean {
  if (!row.match) return false;
  return (row.suggestedBuyerShippingCents !== null && row.suggestedBuyerShippingCents !== (row.buyerShippingCents ?? 0)) || isSuggestedPriceCandidate({
    currentPriceCents: row.priceCents,
    suggestedPriceCents: row.suggestedPriceCents,
    amazonPriceCents: row.match.amazonPriceCents,
    shippingCostCents: row.match.shippingCostCents,
    sitewideDiscountBps,
    adRateBps,
  });
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

function formatFreshness(value: string | null | undefined): string {
  if (!value) return "Not available";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Not available";
  return `Updated ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(timestamp)}`;
}

type ListingSyncProgress = {
  stage: "preparing" | "sources" | "complete";
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
};

type ListingOperationProgress = {
  kind: "enhance" | "match" | "pricing" | "targetProfit";
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  detail?: string;
  status: PremiumProgressStatus;
};

type PricingResultFilter = "all" | "success" | "errors";

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
  const percentage =
    progress.stage === "preparing"
      ? 3
      : progress.stage === "sources"
        ? Math.max(5, Math.round(sourceRatio * 75))
        : 100;
  const title =
    progress.stage === "preparing"
      ? "Preparing your inventory health scan"
      : progress.stage === "sources"
        ? `Verifying Amazon variants · ${progress.completed}/${progress.total}`
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

function ListingOperationStatus({
  progress,
  pricingResults,
  showPricingResults,
  pricingResultFilter,
  onTogglePricingResults,
  onPricingResultFilterChange,
}: {
  progress: ListingOperationProgress;
  pricingResults: CleanupItemResult[];
  showPricingResults: boolean;
  pricingResultFilter: PricingResultFilter;
  onTogglePricingResults: () => void;
  onPricingResultFilterChange: (filter: PricingResultFilter) => void;
}) {
  const percentage = progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : progress.status === "complete" ? 100 : 4;
  const meta = {
    enhance: ["AI-enhancing selected listings", "Generating premium imagery and optimizing enabled listing content."],
    match: ["Matching listings to Amazon sources", "Comparing product identity and exact variants for each listing."],
    pricing: ["Applying profitable suggested prices", "Using administrator-stored Amazon costs before updating each eBay listing."],
    targetProfit: ["Applying target-profit prices", "Calculating the minimum eBay price that reaches your requested modeled net profit."],
  }[progress.kind];
  const filteredPricingResults = pricingResults.filter((result) =>
    pricingResultFilter === "all"
      ? true
      : pricingResultFilter === "errors"
        ? result.action === "error"
        : result.action !== "error",
  );
  return (
    <div className="space-y-3">
      <PremiumProgress
        title={progress.status === "complete" ? `${meta[0]} complete` : meta[0]}
        subtitle={progress.kind === "pricing" && progress.status === "running" ? meta[1] : progress.detail ?? meta[1]}
        percentage={percentage}
        status={progress.status}
        action={progress.kind === "pricing" && pricingResults.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={onTogglePricingResults}>
            {showPricingResults ? "Hide activity" : `Show activity (${pricingResults.length})`}
          </Button>
        ) : undefined}
        stats={progress.kind === "pricing" && progress.status === "running"
          ? [{ label: "processed", value: `${progress.completed}/${progress.total}` }]
          : [
              { label: "processed", value: `${progress.completed}/${progress.total}` },
              { label: "successful", value: progress.succeeded, tone: "success" },
              ...(progress.failed > 0 ? [{ label: "need attention", value: progress.failed, tone: "danger" as const }] : []),
            ]}
      />
      {progress.kind === "pricing" && showPricingResults && (
        <Card className="overflow-hidden border-indigo-100 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Price update activity</p>
              <p className="text-xs text-slate-500">Exact eBay outcomes are retained in Publishing History after completion.</p>
            </div>
            <div className="flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
              {(["all", "success", "errors"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => onPricingResultFilterChange(filter)}
                  className={cx(
                    "rounded-lg px-3 py-1.5 capitalize transition",
                    pricingResultFilter === filter ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800",
                  )}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {filteredPricingResults.map((result, index) => {
              const succeeded = result.action !== "error";
              const updatedPrice = result.newPriceCents ?? result.suggestedPriceCents;
              return (
                <div key={`${result.ebayListingId}-${index}`} className="flex items-start gap-3 px-4 py-3">
                  <span className={cx(
                    "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold",
                    succeeded ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700",
                  )}>
                    {succeeded ? "✓" : "!"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800" title={result.title}>{result.title ?? `eBay item ${result.ebayListingId}`}</p>
                    {result.originalPriceCents !== undefined && updatedPrice !== undefined && (
                      <p className="mt-0.5 text-xs font-medium tabular-nums text-slate-600">
                        {formatCents(result.originalPriceCents)} <span className="px-1 text-slate-400">→</span> {formatCents(updatedPrice)}
                      </p>
                    )}
                    {!succeeded && result.error && <p className="mt-1 whitespace-normal break-words text-xs leading-5 text-red-700">{result.error}</p>}
                  </div>
                  <span className={cx("shrink-0 text-[11px] font-semibold", succeeded ? "text-emerald-700" : "text-red-700")}>
                    {succeeded ? result.action === "repriced" ? "Updated" : "Already current" : "Needs attention"}
                  </span>
                </div>
              );
            })}
            {filteredPricingResults.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-500">No {pricingResultFilter === "all" ? "activity" : pricingResultFilter} to show yet.</p>}
          </div>
        </Card>
      )}
    </div>
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
  onReprice: (priceCents: number, confirmedWinner: boolean) => boolean;
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
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
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
            const confirmedWinner = Boolean(row.verifiedWinner || row.priceLocked);
            if (confirmedWinner && cents !== originalPriceCents && !window.confirm(`“${row.title}” has a protected price${row.verifiedWinner ? " as a Verified Winner" : " after a profitable sale"}. Change its live eBay price from ${formatCents(originalPriceCents)} to ${formatCents(cents)}?`)) {
              onDraftPriceChange(originalPriceCents);
              setPrice((originalPriceCents / 100).toFixed(2));
              return;
            }
            const accepted = onReprice(cents, confirmedWinner);
            if (!accepted) {
              onDraftPriceChange(originalPriceCents);
              setPrice((originalPriceCents / 100).toFixed(2));
              return;
            }
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
  adRateBps,
}: {
  rows: EbayRow[];
  fetchError: string | null;
  improveMainImage: boolean;
  improveListingContent: boolean;
  sitewideDiscountBps: number;
  adRateBps: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<ListingOperationProgress | null>(null);
  const [pricingResults, setPricingResults] = useState<CleanupItemResult[]>([]);
  const [showPricingResults, setShowPricingResults] = useState(false);
  const [pricingResultFilter, setPricingResultFilter] = useState<PricingResultFilter>("all");
  const [syncProgress, setSyncProgress] = useState<ListingSyncProgress | null>(null);
  const [sortKey, setSortKey] = useState<ListingSortKey>("margin");
  const [sortDescending, setSortDescending] = useState(true);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | "attention" | "healthy" | "protected" | "unmatched" | "unprofitable" | "needsPricing" | "recentSales">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetProfitOpen, setTargetProfitOpen] = useState(false);
  const [targetProfitDollars, setTargetProfitDollars] = useState("7.00");
  const [expandedTable, setExpandedTable] = useState(false);
  const [lockedSortOrder, setLockedSortOrder] = useState<string[] | null>(null);

  const problems = rows.filter(listingNeedsAttention).length;
  const suggestedPriceCandidateCount = useMemo(
    () => rows.filter((row) => !row.verifiedWinner && !row.priceLocked && canApplySuggestedPrice(row, sitewideDiscountBps, adRateBps)).length,
    [rows, sitewideDiscountBps, adRateBps],
  );
  const protectedWinnerCandidateCount = useMemo(
    () => rows.filter((row) => Boolean(row.verifiedWinner || row.priceLocked) && canApplySuggestedPrice(row, sitewideDiscountBps, adRateBps)).length,
    [rows, sitewideDiscountBps, adRateBps],
  );
  const targetProfitRows = useMemo(
    () => rows.filter((row) => selected.has(row.ebayListingId) && row.match),
    [rows, selected],
  );
  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      const profit = currentProfit(row, sitewideDiscountBps, adRateBps);
      const matchesSearch = !query || [
        row.title,
        row.ebayListingId,
        row.source?.title,
        row.source?.sku,
        row.source?.category,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
      if (!matchesSearch) return false;
      if (healthFilter === "attention") return listingNeedsAttention(row);
      if (healthFilter === "healthy") return Boolean(row.match && !row.match.unavailable && (profit?.profitCents ?? 0) > 0 && !listingNeedsAttention(row));
      if (healthFilter === "protected") return Boolean(row.verifiedWinner || row.priceLocked);
      if (healthFilter === "unmatched") return !row.match;
      if (healthFilter === "unprofitable") return Boolean(row.match && (profit?.profitCents ?? 0) <= 0);
      if (healthFilter === "needsPricing") return !row.verifiedWinner && !row.priceLocked && canApplySuggestedPrice(row, sitewideDiscountBps, adRateBps);
      if (healthFilter === "recentSales") return (row.performance?.units7d ?? 0) > 0;
      return true;
    });
  }, [adRateBps, healthFilter, rows, searchQuery, sitewideDiscountBps]);

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
        case "profit": return currentProfit(row, sitewideDiscountBps, adRateBps)?.profitCents ?? null;
        case "margin": return currentProfit(row, sitewideDiscountBps, adRateBps)?.marginPct ?? null;
        case "demand": return row.market?.estimatedSales30d ?? null;
        case "competition": return row.market?.competitorCount ?? null;
        case "recommendedPrice": return row.market?.bestSellingPriceCents ?? null;
        case "averagePrice": return row.market?.averageCompetitorPriceCents ?? null;
        case "suggestedPrice": return row.suggestedPriceCents;
        case "matchConfidence": return row.sourceAssessment?.confidence ?? null;
        case "competitiveHealth": return competitiveHealthSortValue(row, sitewideDiscountBps, adRateBps);
        case "sales7d": return row.performance?.units7d ?? 0;
        case "profit30d": return row.performance?.profit30dCents ?? 0;
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
  }, [adRateBps, filteredRows, lockedSortOrder, sitewideDiscountBps, sortKey, sortDescending]);
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
        "Smart Sync will check Amazon sources and listing availability. Ended listings may be relisted when a profitable source is available. Continue?",
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
    });
    startTransition(async () => {
      const totals = { processed: 0, kept: 0, replaced: 0, ended: 0, relisted: 0, stillUnavailable: 0, review: 0 };
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
          });
        }
      }
      await Promise.all(Array.from({ length: 4 }, () => worker()));

      setNotice({
        text: `Smart Sync complete: ${totals.kept} verified, ${totals.replaced} sources updated, ${totals.relisted} relisted, and ${totals.ended} ended${totals.review ? `. ${totals.review} need review` : ""}. Market intelligence continues to come from the administrator catalog.`,
        error: totals.review > 0,
      });
      setSyncProgress((current) => current && ({ ...current, stage: "complete", completed: current.total }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      window.location.reload();
    });
  }

  function cleanUp() {
    const toReprice = rows.filter((row) => !row.verifiedWinner && !row.priceLocked && canApplySuggestedPrice(row, sitewideDiscountBps, adRateBps));
    if (toReprice.length === 0) {
      setNotice({ text: "Nothing to clean up — every matched listing is already at its profitable suggested price.", error: false });
      return;
    }
    if (
      !confirm(
        `Sellfinity found ${toReprice.length} unlocked listing${toReprice.length === 1 ? "" : "s"} whose profitable suggested price differs from the current eBay price. It will use only administrator-stored Amazon pricing and update only prices that still differ.${protectedWinnerCandidateCount ? `\n\n${protectedWinnerCandidateCount} profitable listing price${protectedWinnerCandidateCount === 1 ? " is" : "s are"} locked and excluded from this bulk action.` : ""}\n\nNo Rainforest credits will be used and no listings will be ended. Continue?`,
      )
    ) {
      return;
    }
    const items = toReprice.map((row) => ({
      ebayListingId: row.ebayListingId,
      currentEbayPriceCents: row.priceCents,
      suggestedPriceCents: row.suggestedPriceCents,
      ebayRecommendedPriceCents: row.market?.bestSellingPriceCents,
      averageCompetitorPriceCents: row.market?.averageCompetitorPriceCents,
    }));
    setNotice(null);
    setPricingResults([]);
    setShowPricingResults(false);
    setPricingResultFilter("all");
    setBulkProgress({ kind: "pricing", completed: 0, total: items.length, succeeded: 0, failed: 0, status: "running" });
    startTransition(async () => {
      let repriced = 0, unchanged = 0, errors = 0;
      const completedResults: CleanupItemResult[] = [];
      const errorReasons = new Map<string, number>();
      for (let i = 0; i < items.length; i += PRICE_CLEANUP_BATCH_SIZE) {
        const batch = items.slice(i, i + PRICE_CLEANUP_BATCH_SIZE);
        let results: CleanupItemResult[];
        try {
          results = await cleanupEbayListings(batch);
        } catch (error) {
          const message = error instanceof Error ? error.message : "The pricing request did not finish";
          results = batch.map((item) => ({
            ebayListingId: item.ebayListingId,
            title: rows.find((row) => row.ebayListingId === item.ebayListingId)?.title,
            action: "error" as const,
            originalPriceCents: item.currentEbayPriceCents,
            newPriceCents: item.suggestedPriceCents ?? undefined,
            suggestedPriceCents: item.suggestedPriceCents ?? undefined,
            error: message,
          }));
        }
        completedResults.push(...results);
        setPricingResults([...completedResults]);
        setRows((prev) =>
          prev.flatMap((row) => {
            const r = results.find((x) => x.ebayListingId === row.ebayListingId);
            if (!r) return [row];
            if ((r.action === "repriced" || r.action === "ok") && row.match) {
              return [{
                ...row,
                priceCents: r.newPriceCents ?? row.priceCents,
                buyerShippingCents: r.buyerShippingCents ?? row.buyerShippingCents,
                shippingStrategy: r.shippingStrategy ?? row.shippingStrategy,
                suggestedPriceCents: r.suggestedPriceCents ?? row.suggestedPriceCents,
                suggestedBuyerShippingCents: r.buyerShippingCents ?? row.suggestedBuyerShippingCents,
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
          else if (r.action === "ok") unchanged++;
          else if (r.action === "error") {
            errors++;
            const reason = pricingErrorLabel(r.error);
            errorReasons.set(reason, (errorReasons.get(reason) ?? 0) + 1);
          }
        }
        const completed = Math.min(i + PRICE_CLEANUP_BATCH_SIZE, items.length);
        setBulkProgress({
          kind: "pricing",
          completed,
          total: items.length,
          succeeded: repriced + unchanged,
          failed: errors,
          detail: pricingErrorSummary(errorReasons),
          status: completed === items.length ? "complete" : "running",
        });
      }
      const reasonSummary = pricingErrorSummary(errorReasons);
      let historySaved = false;
      try {
        const history = await recordSuggestedPriceActivity(completedResults);
        historySaved = Boolean(history.batchId);
        router.refresh();
      } catch {
        historySaved = false;
      }
      setNotice({
        text: `Suggested pricing complete: ${repriced} price${repriced === 1 ? "" : "s"} updated${unchanged ? `, ${unchanged} already current after live verification` : ""}${errors ? `, ${errors} need attention${reasonSummary ? `. ${reasonSummary}` : ""}` : ""}.${historySaved ? " Results were saved to Publishing History." : " Publishing History could not be saved; the on-screen results remain available."}`,
        error: errors > 0,
      });
    });
  }

  function applySelectedTargetProfit() {
    const targetProfitCents = parseDollarsToCents(targetProfitDollars);
    if (targetProfitCents === null) {
      setNotice({ text: "Enter valid dollar amounts with no more than two decimal places.", error: true });
      return;
    }
    if (targetProfitRows.length === 0) {
      setNotice({ text: "Select at least one listing with a tracked Amazon source.", error: true });
      return;
    }
    const winnerRows = targetProfitRows.filter((row) => row.verifiedWinner || row.priceLocked);
    if (winnerRows.length > 0 && !confirm(
      `${winnerRows.length} selected profitable listing price${winnerRows.length === 1 ? " is" : "s are"} protected. This target-profit action may change ${winnerRows.length === 1 ? "its" : "their"} locked price.\n\nDo you specifically approve changing the selected locked price${winnerRows.length === 1 ? "" : "s"}?`,
    )) return;
    if (!confirm(
      `Set ${targetProfitRows.length} selected listing${targetProfitRows.length === 1 ? "" : "s"} to earn approximately ${formatCents(targetProfitCents)} net profit per sold item?\n\nThe calculation includes the admin-stored Amazon price and shipping, your ${(adRateBps / 100).toFixed(2)}% ad rate, sitewide discount, estimated eBay final-value fee, and per-order fee.\n\nNo Rainforest credits will be used.`,
    )) return;

    setNotice(null);
    setBulkProgress({ kind: "targetProfit", completed: 0, total: targetProfitRows.length, succeeded: 0, failed: 0, status: "running" });
    startTransition(async () => {
      let succeeded = 0;
      let failed = 0;
      const errors = new Map<string, number>();
      for (let index = 0; index < targetProfitRows.length; index++) {
        const targetRow = targetProfitRows[index];
        let result: Awaited<ReturnType<typeof applyTargetProfitPrice>>;
        try {
          result = await applyTargetProfitPrice(
            targetRow.ebayListingId,
            targetProfitCents,
            Boolean(targetRow.verifiedWinner || targetRow.priceLocked),
          );
        } catch (error) {
          result = {
            ebayListingId: targetRow.ebayListingId,
            ok: false,
            error: error instanceof Error ? error.message : "The target-profit request did not finish.",
          };
        }
        if (result.ok && result.newPriceCents !== undefined) {
          succeeded++;
          const buyerPrice = discountedEbayPriceCents(result.newPriceCents, sitewideDiscountBps) + (result.buyerShippingCents ?? 0);
          const marginPct = buyerPrice > 0 && result.modeledProfitCents !== undefined
            ? Math.round((result.modeledProfitCents / buyerPrice) * 100)
            : 0;
          setRows((current) => current.map((row) => {
            if (row.ebayListingId !== result.ebayListingId || !row.match) return row;
            const amazonPrice = result.amazonPriceCents ?? row.match.amazonPriceCents;
            const amazonShipping = result.amazonShippingCents ?? row.match.shippingCostCents;
            return {
              ...row,
              priceCents: result.newPriceCents!,
              buyerShippingCents: result.buyerShippingCents ?? row.buyerShippingCents,
              shippingStrategy: result.shippingStrategy ?? row.shippingStrategy,
              suggestedBuyerShippingCents: result.buyerShippingCents ?? row.suggestedBuyerShippingCents,
              source: row.source ? {
                ...row.source,
                priceCents: amazonPrice,
                shippingCostCents: amazonShipping,
              } : row.source,
              match: {
                ...row.match,
                amazonPriceCents: amazonPrice,
                shippingCostCents: amazonShipping,
                profitCents: result.modeledProfitCents ?? row.match.profitCents,
                marginPct,
              },
            };
          }));
          setSelected((current) => {
            const next = new Set(current);
            next.delete(result.ebayListingId);
            return next;
          });
        } else {
          failed++;
          const reason = pricingErrorLabel(result.error);
          errors.set(reason, (errors.get(reason) ?? 0) + 1);
        }
        setBulkProgress({
          kind: "targetProfit",
          completed: index + 1,
          total: targetProfitRows.length,
          succeeded,
          failed,
          detail: pricingErrorSummary(errors),
          status: index + 1 === targetProfitRows.length ? "complete" : "running",
        });
      }
      const summary = pricingErrorSummary(errors);
      setNotice({
        text: `Target-profit pricing complete: ${succeeded} updated${failed ? `, ${failed} need attention${summary ? `. ${summary}` : ""}` : ""}.`,
        error: failed > 0,
      });
      if (failed === 0) setTargetProfitOpen(false);
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
          profitCents: currentProfit(row, sitewideDiscountBps, adRateBps)?.profitCents ?? null,
          marginPct: currentProfit(row, sitewideDiscountBps, adRateBps)?.marginPct ?? null,
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
              : (currentProfit(row, sitewideDiscountBps, adRateBps)?.profitCents ?? 0) <= 0
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
  const latestMarketUpdate = rows.reduce<string | null>((latest, row) => {
    if (!row.marketUpdatedAt) return latest;
    return !latest || new Date(row.marketUpdatedAt) > new Date(latest) ? row.marketUpdatedAt : latest;
  }, null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { id: "all" as const, label: "Active listings", value: rows.length, tone: "text-slate-950" },
          { id: "attention" as const, label: "Need attention", value: problems, tone: "text-red-600" },
          { id: "protected" as const, label: "Price protected", value: rows.filter((row) => row.verifiedWinner || row.priceLocked).length, tone: "text-amber-600" },
          { id: "unmatched" as const, label: "Unmatched", value: unmatched, tone: "text-indigo-600" },
        ].map((metric) => (
          <button
            key={metric.id}
            type="button"
            onClick={() => { setHealthFilter(metric.id); setPage(1); }}
            className={cx(
              "group rounded-2xl border bg-white px-3 py-3 text-left shadow-[0_1px_2px_rgba(15,23,42,.04)] transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-950/5 sm:px-4",
              healthFilter === metric.id ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-200/90",
            )}
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[.08em] text-slate-500 sm:text-xs">{metric.label}</span>
            <span className={cx("mt-1 block text-xl font-bold tabular-nums sm:text-2xl", metric.tone)}>{metric.value.toLocaleString()}</span>
          </button>
        ))}
      </div>

      <Card className="overflow-visible p-3 sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search listings</span>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }}
              placeholder="Search title, ASIN, SKU, category or eBay ID…"
              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50/80 pl-10 pr-10 text-sm text-slate-900 outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100/70"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-200 hover:text-slate-700" aria-label="Clear search">×</button>
            )}
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <select
              value={healthFilter}
              onChange={(event) => { setHealthFilter(event.target.value as typeof healthFilter); setPage(1); }}
              className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              aria-label="Filter listing health"
            >
              <option value="all">All listings</option>
              <option value="attention">Needs attention</option>
              <option value="healthy">Healthy & profitable</option>
              <option value="protected">Price protected</option>
              <option value="unmatched">Unmatched</option>
              <option value="unprofitable">Unprofitable</option>
              <option value="needsPricing">Needs pricing</option>
              <option value="recentSales">Sold in last 7 days</option>
            </select>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" aria-label="Items per page">
              <option value={25}>25 per page</option><option value={50}>50 per page</option><option value={100}>100 per page</option>
            </select>
            <Button size="sm" disabled={pending} onClick={syncListingHealth} className="col-span-2 h-11 border-0 bg-gradient-to-r from-indigo-600 to-violet-600 px-4 text-white shadow-md shadow-indigo-200/70 hover:from-indigo-500 hover:to-violet-500 sm:col-auto">
              <SmartSyncIcon spinning={syncProgress !== null && syncProgress.stage !== "complete"} />
              {syncProgress && syncProgress.stage !== "complete" ? "Syncing…" : "Smart Sync"}
            </Button>
            <details className="relative col-span-2 sm:col-auto">
              <summary className="flex h-11 cursor-pointer list-none items-center justify-center rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">More actions ···</summary>
              <div className="absolute right-0 top-12 z-40 grid w-56 gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-900/10 animate-fade-in">
                <button type="button" disabled={pending} onClick={exportExcel} className="rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">Export current results</button>
                {unmatched > 0 && <button type="button" disabled={pending} onClick={matchAll} className="rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50">Match all unmatched ({unmatched})</button>}
              </div>
            </details>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500"><span className="font-semibold text-slate-800">{filteredRows.length.toLocaleString()}</span> results{selected.size ? ` · ${selected.size} selected` : ""} · Market pricing is maintained by admin · {formatFreshness(latestMarketUpdate)}.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={pending || suggestedPriceCandidateCount === 0} onClick={cleanUp}>{bulkProgress?.kind === "pricing" && bulkProgress.status === "running" ? "Applying…" : `Apply suggested (${suggestedPriceCandidateCount})`}</Button>
            <Button size="sm" variant="secondary" disabled={pending || targetProfitRows.length === 0} onClick={() => setTargetProfitOpen((current) => !current)}>{targetProfitOpen ? "Close profit tool" : `Target profit (${targetProfitRows.length})`}</Button>
            <Button size="sm" disabled={pending || selected.size === 0 || (!improveMainImage && !improveListingContent)} onClick={enhanceSelected} title={!improveMainImage && !improveListingContent ? "Enable an AI listing enhancement preference in Settings first" : "Apply your Settings preferences to selected listings"} className="border-0 bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-sm hover:from-violet-500 hover:to-fuchsia-500">✨ {bulkProgress?.kind === "enhance" && bulkProgress.status === "running" ? `Enhancing ${bulkProgress.completed}/${bulkProgress.total}` : `Enhance (${selected.size})`}</Button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-0.5">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">Saved views</span>
          {[
            ["healthy", "Profitable"],
            ["needsPricing", "Needs pricing"],
            ["recentSales", "Recent sellers"],
            ["protected", "Protected winners"],
          ].map(([id, label]) => (
            <button key={id} type="button" onClick={() => { setHealthFilter(id as typeof healthFilter); setPage(1); }} className={cx("shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition", healthFilter === id ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:text-indigo-700")}>{label}</button>
          ))}
        </div>
        {protectedWinnerCandidateCount > 0 && <p className="mt-2 text-[11px] text-amber-700">🔒 {protectedWinnerCandidateCount} profitable price{protectedWinnerCandidateCount === 1 ? " is" : "s are"} protected and excluded from automatic price changes.</p>}
      </Card>

      {notice && <div className={cx("animate-fade-in rounded-xl border px-4 py-3 text-sm", notice.error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>{notice.text}</div>}

      {targetProfitOpen && (
        <Card className="border-indigo-200 bg-gradient-to-br from-white to-indigo-50/60 p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-900">Target net profit</h3>
                <Badge tone="indigo">{targetProfitRows.length} selected</Badge>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Sets the minimum eBay price needed to reach your chosen profit per sold item. Uses admin-stored Amazon pricing and no Rainforest credits.
              </p>
            </div>
            <label className="block min-w-0 sm:w-48">
              <span className="text-xs font-semibold text-slate-700">Desired profit per item</span>
              <div className="mt-1 flex items-center rounded-xl border border-slate-300 bg-white px-3 shadow-sm focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100">
                <span className="text-sm text-slate-500">$</span>
                <input
                  inputMode="decimal"
                  value={targetProfitDollars}
                  onChange={(event) => setTargetProfitDollars(event.target.value)}
                  className="min-h-10 w-full bg-transparent px-2 text-right text-sm font-semibold tabular-nums outline-none"
                  aria-label="Desired net profit per item"
                />
              </div>
            </label>
            <Button disabled={pending || targetProfitRows.length === 0} onClick={applySelectedTargetProfit} className="lg:mb-[1px]">
              {bulkProgress?.kind === "targetProfit" && bulkProgress.status === "running" ? "Applying…" : "Calculate & apply"}
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-500">
            Approximate profit uses the configured eBay fee assumptions and excludes Amazon sales tax. Actual profit can vary with category-specific eBay fees or other order charges.
          </p>
        </Card>
      )}

      {bulkProgress ? (
        <ListingOperationStatus
          progress={bulkProgress}
          pricingResults={pricingResults}
          showPricingResults={showPricingResults}
          pricingResultFilter={pricingResultFilter}
          onTogglePricingResults={() => setShowPricingResults((current) => !current)}
          onPricingResultFilterChange={setPricingResultFilter}
        />
      ) : syncProgress && <SmartSyncStatus progress={syncProgress} />}

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
                className="hidden! md:inline-flex!"
              >
                {expandedTable ? "↙ Exit full screen" : "↗ Expand table"}
              </Button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 md:hidden">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Sort listings</span>
              <select
                value={`${sortKey}:${sortDescending ? "desc" : "asc"}`}
                onChange={(event) => {
                  const [nextKey, direction] = event.target.value.split(":") as [ListingSortKey, "asc" | "desc"];
                  setSortKey(nextKey);
                  setSortDescending(direction === "desc");
                  setPage(1);
                }}
                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                aria-label="Sort listings"
              >
                <option value="margin:desc">Highest margin</option>
                <option value="profit:desc">Highest profit</option>
                <option value="demand:desc">Most sales</option>
                <option value="sales7d:desc">Most units sold (7d)</option>
                <option value="profit30d:desc">Highest profit (30d)</option>
                <option value="listingDate:desc">Newest listings</option>
                <option value="competitiveHealth:asc">Needs attention first</option>
                <option value="ebayTitle:asc">Product name A–Z</option>
                <option value="price:asc">Lowest eBay price</option>
                <option value="price:desc">Highest eBay price</option>
              </select>
            </label>
            <label className="flex h-11 shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600">
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
                className="h-4 w-4 rounded border-slate-300"
              />
              Select page
            </label>
          </div>
        </div>
        <div className="overflow-x-auto border-b border-slate-200 md:hidden">
          <table className="w-full min-w-[680px] table-fixed text-xs">
            <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="sticky left-0 z-20 w-[230px] border-r border-slate-200 bg-slate-50 px-3 py-2.5 text-left">Product</th>
                <th className="w-[78px] px-2 py-2.5 text-right">eBay</th>
                <th className="w-[78px] px-2 py-2.5 text-right">Amazon</th>
                <th className="w-[90px] px-2 py-2.5 text-right">Profit</th>
                <th className="w-[82px] px-2 py-2.5 text-right">Suggested</th>
                <th className="w-[58px] px-2 py-2.5 text-right">Sold 7d</th>
                <th className="w-[70px] px-2 py-2.5 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visibleRows.map((r) => {
                const profit = currentProfit(r, sitewideDiscountBps, adRateBps);
                const problem = listingNeedsAttention(r);
                const analyticsUrl = r.source?.sku
                  ? `/analytics/asins/${encodeURIComponent(r.source.sku)}`
                  : r.url;
                const status = !r.match
                  ? "Unmatched"
                  : r.match.unavailable
                    ? "No source"
                    : (profit?.profitCents ?? 0) <= 0
                      ? "Loss"
                      : "OK";
                return (
                  <tr key={`mobile-row-${r.ebayListingId}`} className={cx("align-middle", problem && "bg-red-50/40")}>
                    <td className={cx("sticky left-0 z-10 border-r border-slate-100 px-2 py-2", problem ? "bg-red-50" : "bg-white")}>
                      <div className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.ebayListingId)}
                          onChange={() => toggleSelected(r.ebayListingId)}
                          aria-label={`Select ${r.title}`}
                          className="h-4 w-4 shrink-0 rounded border-slate-300"
                        />
                        {r.source?.imageUrl || r.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.source?.imageUrl || r.imageUrl || ""}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded-md border border-slate-200 bg-white object-contain"
                          />
                        ) : (
                          <div className="h-10 w-10 shrink-0 rounded-md bg-slate-100" />
                        )}
                        <div className="min-w-0">
                          <a
                            href={analyticsUrl}
                            target={r.source?.sku ? undefined : "_blank"}
                            rel={r.source?.sku ? undefined : "noreferrer"}
                            className="line-clamp-2 break-words text-[12px] font-semibold leading-4 text-slate-800 hover:text-indigo-600"
                            title={r.source?.title ?? r.title}
                          >
                            {r.source?.title ?? r.title}
                          </a>
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">
                            <span className="truncate">{r.source?.sku ?? `#${r.ebayListingId}`}</span>
                            {r.verifiedWinner && <span title="Verified Winner">🏆</span>}
                            {!r.verifiedWinner && r.priceLocked && <span title="Price locked after profitable sale">🔒</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums text-slate-900">{formatCents(r.priceCents)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-600">
                      {r.source ? formatCents(r.source.priceCents + r.source.shippingCostCents) : "—"}
                    </td>
                    <td className={cx("px-2 py-2 text-right font-semibold tabular-nums", profit && profit.profitCents > 0 ? "text-emerald-700" : "text-red-600")}>
                      <span className="block">{profit ? formatCents(profit.profitCents) : "—"}</span>
                      {profit && <span className="block text-[10px] font-normal opacity-75">{profit.marginPct}%</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums text-indigo-700">
                      {r.suggestedPriceCents !== null ? formatCents(r.suggestedPriceCents) : "—"}
                    </td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums text-slate-700">
                      {r.performance?.units7d.toLocaleString() ?? "0"}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className={cx(
                        "inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                        status === "OK" ? "bg-emerald-50 text-emerald-700" : status === "Loss" || status === "No source" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700",
                      )}>
                        {status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && !fetchError && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">
                    No listings match your current search and filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {false && <div className="hidden">
          {visibleRows.map((r) => {
            const problem = listingNeedsAttention(r);
            const health = assessListingHealth(r, sitewideDiscountBps, adRateBps);
            const profit = currentProfit(r, sitewideDiscountBps, adRateBps);
            const priceAssessment = assessPriceCompetitiveness(
              r.priceCents,
              r.priceCents,
              r.market?.averageCompetitorPriceCents,
              r.market?.bestSellingPriceCents,
              r.suggestedPriceCents,
              sitewideDiscountBps,
            );
            const status = !r.match
              ? r.sourceAssessment
                ? { label: "Review source", tone: "amber" as const }
                : { label: "Unmatched", tone: "slate" as const }
              : r.match.unavailable
                ? { label: "Not on Amazon", tone: "red" as const }
                : (profit?.profitCents ?? 0) <= 0
                  ? { label: "Unprofitable", tone: "red" as const }
                  : { label: "Healthy", tone: "green" as const };
            return (
              <article
                key={`mobile-${r.ebayListingId}`}
                className={cx(
                  "bg-white px-4 py-4",
                  problem && "border-l-4 border-l-red-400 bg-red-50/30",
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(r.ebayListingId)}
                    onChange={() => toggleSelected(r.ebayListingId)}
                    aria-label={`Select ${r.title}`}
                    className="mt-1 h-5 w-5 shrink-0 rounded border-slate-300"
                  />
                  {r.source?.imageUrl || r.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.source?.imageUrl || r.imageUrl || ""}
                      alt=""
                      className="h-16 w-16 shrink-0 rounded-xl border border-slate-200 bg-white object-contain shadow-sm"
                    />
                  ) : (
                    <div className="h-16 w-16 shrink-0 rounded-xl bg-slate-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {r.verifiedWinner && <Badge tone="amber">🏆 Winner · locked</Badge>}
                      {!r.verifiedWinner && r.priceLocked && <Badge tone="indigo">🔒 Price locked · profitable sale</Badge>}
                    </div>
                    {r.source ? (
                      <a
                        href={r.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block break-words text-sm font-semibold leading-5 text-slate-900 hover:text-indigo-600"
                      >
                        {r.source.title}
                      </a>
                    ) : (
                      <p className="break-words text-sm font-semibold leading-5 text-slate-800">{r.title}</p>
                    )}
                    <p className="mt-1 break-all text-[11px] text-slate-500">
                      {r.source?.sku ?? `eBay #${r.ebayListingId}`}
                    </p>
                  </div>
                </div>

                {r.source && (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">eBay listing</p>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block break-words text-xs font-medium leading-5 text-slate-700 hover:text-indigo-600"
                    >
                      {r.title}
                    </a>
                    <p className="mt-1 text-[11px] text-slate-500">
                      #{r.ebayListingId}{r.quantity !== null && ` · ${r.quantity} available`}
                    </p>
                  </div>
                )}

                <dl className="mt-3 grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="col-span-2 flex min-w-0 items-start justify-between gap-3 border-b border-slate-100 p-3">
                    <div className="min-w-0">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">eBay price · tap to edit</dt>
                      <dd className="mt-1 text-base font-bold text-slate-900">
                        <RepriceCell
                          row={r}
                          pending={pending}
                          onEditingChange={(editing) => setLockedSortOrder(editing ? sortedRows.map((row) => row.ebayListingId) : null)}
                          onDraftPriceChange={(priceCents) => setRows((prev) => prev.map((x) => x.ebayListingId === r.ebayListingId ? { ...x, priceCents } : x))}
                          onReprice={(priceCents, confirmedWinner) => {
                            run(r.ebayListingId, () => repriceEbayListing(r.ebayListingId, priceCents, confirmedWinner), () => setRows((prev) => prev.map((x) => x.ebayListingId === r.ebayListingId ? { ...x, priceCents } : x)), "Price updated on eBay.");
                            return true;
                          }}
                        />
                      </dd>
                    </div>
                    <div className="shrink-0 text-right">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Amazon cost</dt>
                      <dd className="mt-1 text-base font-bold tabular-nums text-slate-900">
                        {r.source ? formatCents(r.source.priceCents + r.source.shippingCostCents) : "—"}
                      </dd>
                    </div>
                  </div>
                  <div className="border-b border-r border-slate-100 p-3">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Profit after ads</dt>
                    <dd className={cx("mt-1 text-base font-bold tabular-nums", profit && profit.profitCents > 0 ? "text-emerald-700" : "text-red-600")}>
                      {profit ? formatCents(profit.profitCents) : "—"}
                    </dd>
                  </div>
                  <div className="border-b border-slate-100 p-3">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Margin</dt>
                    <dd className={cx("mt-1 text-base font-bold tabular-nums", profit && profit.marginPct >= 15 ? "text-emerald-700" : "text-amber-700")}>
                      {profit ? `${profit.marginPct}%` : "—"}
                    </dd>
                  </div>
                  <div className="border-r border-slate-100 p-3">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Suggested</dt>
                    <dd className="mt-1 text-sm font-semibold tabular-nums text-indigo-700">
                      {r.suggestedPriceCents !== null ? formatCents(r.suggestedPriceCents) : "—"}
                    </dd>
                  </div>
                  <div className="p-3">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Competitor avg</dt>
                    <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-700">
                      {r.market ? formatCents(r.market.averageCompetitorPriceCents) : "—"}
                    </dd>
                    <p className="mt-0.5 text-[9px] text-slate-400">{formatFreshness(r.marketUpdatedAt)}</p>
                  </div>
                </dl>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="rounded-xl bg-slate-50 p-2.5 text-center">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">Sold 7d / 30d</p>
                    <p className="mt-0.5 text-sm font-bold tabular-nums text-slate-800">{r.performance?.units7d ?? 0} / {r.performance?.units30d ?? 0}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2.5 text-center">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">Profit 7d / 30d</p>
                    <p className={cx("mt-0.5 text-xs font-bold tabular-nums", (r.performance?.profit30dCents ?? 0) >= 0 ? "text-emerald-700" : "text-red-600")}>{formatCents(r.performance?.profit7dCents ?? 0)} / {formatCents(r.performance?.profit30dCents ?? 0)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2.5 text-center">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">Listed</p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-700">{formatListingDate(r.listingDate)}</p>
                  </div>
                </div>

                <div className="mt-3 rounded-xl bg-indigo-50/70 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={priceAssessment.tone}>{priceAssessment.label}</Badge>
                    <Badge tone={health.status === "COMPETITIVE" ? "green" : health.status === "SOURCE_ISSUE" || health.status === "UNPROFITABLE" ? "red" : "amber"}>{health.label}</Badge>
                  </div>
                  <p className="mt-1.5 break-words text-xs leading-5 text-slate-600">{priceAssessment.summary}</p>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-indigo-700 shadow-sm"
                  >
                    View on eBay ↗
                  </a>
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
                      onClick={() => run(
                        r.ebayListingId,
                        () => unmatchEbayListing(r.ebayListingId),
                        () => setRows((prev) => prev.map((x) => x.ebayListingId === r.ebayListingId ? { ...x, match: null, sourceAssessment: null } : x)),
                        "Unmatched.",
                      )}
                    >
                      Unmatch
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    className="ml-auto"
                    onClick={() => {
                      if (!confirm(`End "${r.title.slice(0, 50)}…" on eBay?`)) return;
                      run(
                        r.ebayListingId,
                        () => endEbayListing(r.ebayListingId),
                        () => setRows((prev) => prev.filter((x) => x.ebayListingId !== r.ebayListingId)),
                        "Listing ended on eBay.",
                      );
                    }}
                  >
                    {busyId === r.ebayListingId ? "Working…" : "End"}
                  </Button>
                </div>
              </article>
            );
          })}
          {filteredRows.length === 0 && !fetchError && (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              No listings match your current search and filter.
            </div>
          )}
        </div>}
        <div
          className={cx(
            "hidden overflow-auto md:block",
            expandedTable ? "min-h-0 flex-1" : "max-h-[72vh]",
          )}
        >
        <table className="w-full min-w-[3600px] text-sm">
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
              <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Shipping strategy</th>
              <ListingSortHeader label="Competitor avg" value="averagePrice" active={sortKey === "averagePrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="eBay recommended" value="recommendedPrice" active={sortKey === "recommendedPrice"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Suggested price" value="suggestedPrice" active={sortKey === "suggestedPrice"} descending={sortDescending} onSort={sortBy} />
              <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Price assessment</th>
              <ListingSortHeader label="Sales / month" value="demand" active={sortKey === "demand"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Competition" value="competition" active={sortKey === "competition"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Profit after ads" value="profit" active={sortKey === "profit"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Margin after ads" value="margin" active={sortKey === "margin"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Units 7d / 30d" value="sales7d" active={sortKey === "sales7d"} descending={sortDescending} onSort={sortBy} />
              <ListingSortHeader label="Profit 7d / 30d" value="profit30d" active={sortKey === "profit30d"} descending={sortDescending} onSort={sortBy} />
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
              const health = assessListingHealth(r, sitewideDiscountBps, adRateBps);
              const profit = currentProfit(r, sitewideDiscountBps, adRateBps);
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
                          {r.verifiedWinner && <Badge tone="amber">🏆 Verified winner · price locked</Badge>}
                          {!r.verifiedWinner && r.priceLocked && <Badge tone="indigo">🔒 Price locked · profitable sale</Badge>}
                          {r.source && <Badge tone={r.source.stock > 0 ? "green" : "red"}>{r.source.stock > 0 ? `${r.source.stock} in stock` : "Unavailable"}</Badge>}
                          {r.sourceAssessment && <Badge tone={r.sourceAssessment.confidence !== null && r.sourceAssessment.confidence >= 95 ? "green" : "amber"}>{r.sourceAssessment.verdict} {r.sourceAssessment.confidence ?? "—"}%</Badge>}
                          <Badge tone={(r.buyerShippingCents ?? 0) > 0 ? "indigo" : "slate"}>{(r.buyerShippingCents ?? 0) > 0 ? `${formatCents(r.buyerShippingCents ?? 0)} shipping` : r.shippingStrategy ? "Free shipping" : "Shipping unknown"}</Badge>
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
                      onReprice={(priceCents, confirmedWinner) => {
                        run(r.ebayListingId, () => repriceEbayListing(r.ebayListingId, priceCents, confirmedWinner), () => setRows((prev) => prev.map((x) => x.ebayListingId === r.ebayListingId ? { ...x, priceCents } : x)), "Price updated on eBay.");
                        return true;
                      }}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-left">
                    {r.shippingStrategy ? <><Badge tone={(r.buyerShippingCents ?? 0) > 0 ? "indigo" : "slate"}>{(r.buyerShippingCents ?? 0) > 0 ? "Buyer paid" : "Free shipping"}</Badge>{(r.buyerShippingCents ?? 0) > 0 && <p className="mt-1 text-xs font-medium text-slate-600">{formatCents(r.buyerShippingCents ?? 0)}</p>}</> : <span className="text-slate-400">Unknown</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums">{r.market ? formatCents(r.market.averageCompetitorPriceCents) : "—"}<p className="mt-0.5 text-[10px] text-slate-400">{formatFreshness(r.marketUpdatedAt)}</p></td>
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
                        {r.suggestedBuyerShippingCents !== null && <p className="mt-0.5 whitespace-nowrap text-[10px] font-normal text-slate-500">{r.suggestedBuyerShippingCents > 0 ? `+ ${formatCents(r.suggestedBuyerShippingCents)} buyer shipping` : "Free shipping"}</p>}
                        <p className="mt-0.5 whitespace-nowrap text-[10px] font-normal text-slate-500">
                          {Math.round(
                            (trueProfitCents(
                              r.suggestedPriceCents,
                              r.match.amazonPriceCents,
                              r.match.shippingCostCents,
                              sitewideDiscountBps,
                              adRateBps,
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
                  <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums"><span className="font-semibold text-slate-800">{r.performance?.units7d ?? 0}</span><span className="ml-1 text-xs text-slate-400">/ {r.performance?.units30d ?? 0}</span></td>
                  <td className={cx("whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums", (r.performance?.profit30dCents ?? 0) >= 0 ? "text-emerald-700" : "text-red-600")}>{formatCents(r.performance?.profit7dCents ?? 0)}<span className="ml-1 text-xs font-normal text-slate-400">/ {formatCents(r.performance?.profit30dCents ?? 0)}</span></td>
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
                  No listings match your current search and filter.
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
