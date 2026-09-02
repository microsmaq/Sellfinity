"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  cleanupEbayListings,
  applyTargetProfitPrice,
  approveAmazonCandidate,
  approveAmazonCandidatesBulk,
  enhanceEbayListing,
  endEbayListing,
  endUnmatchedEbayListing,
  exportEbayListings,
  findAmazonCandidateForReview,
  matchEbayListing,
  matchEbayListingsBatch,
  repriceEbayListing,
  recordSuggestedPriceActivity,
  recordSmartSyncActivity,
  rejectAmazonCandidate,
  setAmazonCandidateFromInput,
  unmatchEbayListing,
  prepareConfigurableSmartSync,
  processConfigurableSmartSyncItem,
  updateListingAmazonCostsFromBrowser,
  markListingAmazonUnavailableFromBrowser,
} from "@/lib/actions/ebay-listings";
import type { CleanupItemResult, SmartSyncItemResult } from "@/lib/actions/ebay-listings";
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
import {
  DEFAULT_SMART_SYNC_OPTIONS,
  hasSelectedSmartSyncOption,
  selectedSmartSyncOptionCount,
  type SmartSyncOptions,
} from "@/lib/listings/smart-sync-options";
import { isAmazonDataFresh } from "@/lib/amazon/freshness";

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
  amazonUpdatedAt?: string | null;
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

function matchAssessmentLabel(assessment: EbayRow["sourceAssessment"]): string {
  if (!assessment) return "Untracked";
  if (assessment.method === "MANUAL") return "Manually verified · 100%";
  if (assessment.method === "MANUAL_REJECTED") return "Seller rejected";
  if (assessment.verdict === "UNVERIFIED") return "Not checked";
  return `${assessment.verdict.toLowerCase()} ${assessment.confidence ?? "—"}%`;
}

function isHighConfidenceReview(row: EbayRow): boolean {
  const confidence = row.sourceAssessment?.confidence;
  return Boolean(
    row.source &&
    row.sourceAssessment &&
    ["MATCH", "LIKELY", "REVIEW", "UNVERIFIED", "PROCESSING"].includes(row.sourceAssessment.verdict) &&
    row.sourceAssessment.method !== "MANUAL" &&
    confidence !== null &&
    confidence !== undefined &&
    confidence >= 95 &&
    confidence <= 100,
  );
}

function isApprovableCandidate(row: EbayRow): boolean {
  return Boolean(
    !row.match &&
    row.source &&
    row.sourceAssessment &&
    row.sourceAssessment.method !== "MANUAL",
  );
}

type ListingSyncProgress = {
  stage: "preparing" | "running" | "complete";
  completed: number;
  total: number;
  successful: number;
  errors: number;
  needsAttention: number;
  updated: number;
  ended: number;
  relisted: number;
};

type SmartSyncResultFilter = "all" | "success" | "needs_attention" | "errors";

const SMART_SYNC_OPTION_META: Array<{
  key: keyof SmartSyncOptions;
  label: string;
  description: string;
}> = [
  {
    key: "refreshEbayListings",
    label: "Refresh eBay listing data",
    description: "Call eBay once for this run and save the latest active-listing details locally.",
  },
  {
    key: "refreshAmazonData",
    label: "Refresh Amazon cost & availability",
    description: "Sync the latest administrator-stored price, shipping, stock, and product details.",
  },
  {
    key: "checkLiveAmazonPrices",
    label: "Check live Amazon prices",
    description: "Use the signed-in Chrome helper to verify current price and shipping once per unique ASIN before syncing.",
  },
  {
    key: "applySuggestedPrices",
    label: "Apply profitable suggested prices",
    description: "Update only unlocked listings whose item price or buyer shipping should change.",
  },
  {
    key: "updateListingImages",
    label: "Update eBay product images",
    description: "Use admin-maintained Amazon images and automatically meet eBay image-size requirements.",
  },
  {
    key: "endUnavailableListings",
    label: "End unavailable-source listings",
    description: "End items only when Amazon or the administrator catalog clearly confirms the source is unavailable. Sign-in, CAPTCHA, and temporary read failures are never ended.",
  },
  {
    key: "relistRecoveredProducts",
    label: "Relist recovered products",
    description: "Relist Sellfinity-ended products after their Amazon source becomes available again.",
  },
];

type ListingOperationProgress = {
  kind: "delist" | "enhance" | "match" | "pricing" | "targetProfit";
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

function SmartSyncStatus({
  progress,
  results,
  showResults,
  resultFilter,
  onToggleResults,
  onResultFilterChange,
}: {
  progress: ListingSyncProgress;
  results: SmartSyncItemResult[];
  showResults: boolean;
  resultFilter: SmartSyncResultFilter;
  onToggleResults: () => void;
  onResultFilterChange: (filter: SmartSyncResultFilter) => void;
}) {
  const percentage = progress.stage === "preparing"
    ? 3
    : progress.total > 0 ? Math.round(progress.completed / progress.total * 100) : 100;
  const filteredResults = results.filter((result) =>
    resultFilter === "all"
      ? true
      : resultFilter === "errors"
        ? result.status === "error"
        : result.status === resultFilter,
  );
  return (
    <div className="space-y-3">
      <PremiumProgress
        title={progress.stage === "complete" ? "Smart Sync complete" : progress.stage === "preparing" ? "Preparing Smart Sync" : "Smart Sync is updating your listings"}
        subtitle={progress.stage === "complete" ? "Selected operations are complete. Item-level activity remains available below." : "Using the selected Amazon and eBay data sources. Keep this page open while the selected operations run."}
        percentage={percentage}
        status={progress.stage === "complete" ? "complete" : "running"}
        action={results.length > 0 ? <Button size="sm" variant="secondary" onClick={onToggleResults}>{showResults ? "Hide activity" : `Show activity (${results.length})`}</Button> : undefined}
        stats={[
          { label: "processed", value: `${progress.completed}/${progress.total}` },
          { label: "successful", value: progress.successful, tone: "success" },
          ...(progress.errors > 0 ? [{ label: "errors", value: progress.errors, tone: "danger" as const }] : []),
          ...(progress.needsAttention > 0 ? [{ label: "need attention", value: progress.needsAttention, tone: "warning" as const }] : []),
        ]}
      />
      {showResults && (
        <Card className="overflow-hidden border-indigo-100 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div><p className="text-sm font-semibold text-slate-900">Smart Sync activity</p><p className="text-xs text-slate-500">Results and exact errors for every processed listing.</p></div>
            <div className="flex max-w-full overflow-x-auto rounded-xl bg-slate-100 p-1 text-xs font-semibold">
              {(["all", "success", "needs_attention", "errors"] as const).map((filter) => (
                <button key={filter} type="button" onClick={() => onResultFilterChange(filter)} className={cx("shrink-0 rounded-lg px-3 py-1.5 transition", resultFilter === filter ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800")}>{filter === "needs_attention" ? "Needs attention" : filter[0].toUpperCase() + filter.slice(1)}</button>
              ))}
            </div>
          </div>
          <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {filteredResults.map((result) => (
              <div key={result.listingId} className="flex items-start gap-3 px-4 py-3">
                <span className={cx("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold", result.status === "success" ? "bg-emerald-50 text-emerald-700" : result.status === "error" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{result.status === "success" ? "✓" : "!"}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800" title={result.title}>{result.title}</p>
                  {result.actions.length > 0 && <p className="mt-0.5 text-xs leading-5 text-slate-600">{result.actions.join(" · ")}</p>}
                  {result.originalPriceCents !== result.newPriceCents && <p className="mt-0.5 text-xs font-medium tabular-nums text-slate-600">{formatCents(result.originalPriceCents)} <span className="px-1 text-slate-400">→</span> {formatCents(result.newPriceCents)}</p>}
                  {result.error && <p className={cx("mt-1 whitespace-normal break-words text-xs leading-5", result.status === "error" ? "text-red-700" : "text-amber-700")}>{result.error}</p>}
                </div>
                <span className={cx("shrink-0 text-[11px] font-semibold capitalize", result.status === "success" ? "text-emerald-700" : result.status === "error" ? "text-red-700" : "text-amber-700")}>{result.outcome.replace("_", " ")}</span>
              </div>
            ))}
            {filteredResults.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-500">No matching activity yet.</p>}
          </div>
        </Card>
      )}
    </div>
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
    delist: ["Delisting unmatched items", "Ending the selected items on eBay because no approved Amazon source is available."],
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
  const [smartSyncOpen, setSmartSyncOpen] = useState(false);
  const [smartSyncOptions, setSmartSyncOptions] = useState<SmartSyncOptions>({ ...DEFAULT_SMART_SYNC_OPTIONS });
  const [smartSyncScope, setSmartSyncScope] = useState<"ALL" | "SELECTED">("ALL");
  const [skipFreshAmazon, setSkipFreshAmazon] = useState(true);
  const [amazonPriceBridgeIds, setAmazonPriceBridgeIds] = useState<string[]>([]);
  const [amazonPriceProgress, setAmazonPriceProgress] = useState<{ status: "starting" | "running" | "complete" | "cancelled" | "error"; total: number; processed: number; found: number } | null>(null);
  const amazonPriceResolver = useRef<((result: { availableIds: Set<string>; unavailableIds: Set<string>; skippedFresh: number }) => void) | null>(null);
  const amazonPriceSkippedFresh = useRef(0);
  const amazonPriceRejecter = useRef<((error: Error) => void) | null>(null);
  const amazonPriceSuccessfulIds = useRef(new Set<string>());
  const amazonUnavailableIds = useRef(new Set<string>());
  const amazonPriceSavePromises = useRef<Promise<void>[]>([]);
  const amazonPriceStartupTimer = useRef<number | null>(null);
  const [syncResults, setSyncResults] = useState<SmartSyncItemResult[]>([]);
  const [showSyncResults, setShowSyncResults] = useState(false);
  const [syncResultFilter, setSyncResultFilter] = useState<SmartSyncResultFilter>("all");
  const [retryLastSyncErrorsOnly, setRetryLastSyncErrorsOnly] = useState(false);
  const [sortKey, setSortKey] = useState<ListingSortKey>("margin");
  const [sortDescending, setSortDescending] = useState(true);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | "attention" | "healthy" | "protected" | "unmatched" | "highConfidence" | "unprofitable" | "needsPricing" | "recentSales">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkApprovalProgress, setBulkApprovalProgress] = useState<{ completed: number; total: number } | null>(null);
  const [manualAmazonInputs, setManualAmazonInputs] = useState<Record<string, string>>({});
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
      if (healthFilter === "unmatched") return !row.match && row.sourceAssessment?.method !== "MANUAL";
      if (healthFilter === "highConfidence") return isHighConfidenceReview(row);
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
  const smartSyncTargetRows = smartSyncScope === "SELECTED"
    ? rows.filter((row) => selected.has(row.ebayListingId))
    : rows;
  const approvalRowsInView = healthFilter === "unmatched"
    ? filteredRows.filter(isApprovableCandidate)
    : filteredRows.filter(isHighConfidenceReview);
  const selectionRowsInView = healthFilter === "unmatched" ? filteredRows : approvalRowsInView;
  const selectedApprovalRows = approvalRowsInView.filter((row) => selected.has(row.ebayListingId));
  const selectedUnmatchedRows = healthFilter === "unmatched" ? filteredRows.filter((row) => selected.has(row.ebayListingId)) : [];
  const allApprovalRowsSelected = selectionRowsInView.length > 0 && selectionRowsInView.every((row) => selected.has(row.ebayListingId));

  useEffect(() => {
    function receiveAmazonPrice(event: Event) {
      const detail = (event as CustomEvent<{ orderIds?: string[]; unitPriceCents?: number; shippingCents?: number | null }>).detail;
      if (!detail?.orderIds?.length || !Number.isFinite(detail.unitPriceCents)) return;
      const save = (async () => {
        const result = await updateListingAmazonCostsFromBrowser(
          detail.orderIds!,
          detail.unitPriceCents!,
          detail.shippingCents ?? null,
        );
        if ("error" in result) return;
        for (const id of result.updatedEbayListingIds) amazonPriceSuccessfulIds.current.add(id);
        setRows((current) => current.map((row) => result.updatedEbayListingIds.includes(row.ebayListingId) && row.match
          ? {
              ...row,
              amazonUpdatedAt: result.amazonRefreshedAt,
              match: {
                ...row.match,
                amazonPriceCents: result.amazonPriceCents,
                shippingCostCents: result.amazonShippingCents ?? row.match.shippingCostCents,
                unavailable: false,
              },
            }
          : row));
      })();
      amazonPriceSavePromises.current.push(save);
    }
    function receiveAmazonUnavailable(event: Event) {
      const detail = (event as CustomEvent<{ orderIds?: string[] }>).detail;
      if (!detail?.orderIds?.length) return;
      const save = (async () => {
        const result = await markListingAmazonUnavailableFromBrowser(detail.orderIds!);
        if ("error" in result) return;
        for (const id of result.updatedEbayListingIds) amazonUnavailableIds.current.add(id);
        setRows((current) => current.map((row) => result.updatedEbayListingIds.includes(row.ebayListingId) && row.match
          ? { ...row, amazonUpdatedAt: result.amazonRefreshedAt, match: { ...row.match, unavailable: true } }
          : row));
      })();
      amazonPriceSavePromises.current.push(save);
    }
    function receiveAmazonPriceProgress(event: Event) {
      const detail = (event as CustomEvent<{ status?: "running" | "complete" | "cancelled" | "error"; total?: number; processed?: number; found?: number }>).detail;
      if (!detail?.status) return;
      if (amazonPriceStartupTimer.current !== null) {
        window.clearTimeout(amazonPriceStartupTimer.current);
        amazonPriceStartupTimer.current = null;
      }
      setAmazonPriceProgress({
        status: detail.status,
        total: detail.total ?? 0,
        processed: detail.processed ?? 0,
        found: detail.found ?? 0,
      });
      if (detail.status === "complete" && amazonPriceResolver.current) {
        const resolve = amazonPriceResolver.current;
        amazonPriceResolver.current = null;
        amazonPriceRejecter.current = null;
        void Promise.all(amazonPriceSavePromises.current).then(() => resolve({
          availableIds: new Set(amazonPriceSuccessfulIds.current),
          unavailableIds: new Set(amazonUnavailableIds.current),
          skippedFresh: amazonPriceSkippedFresh.current,
        }));
      }
      if (detail.status === "cancelled" && amazonPriceRejecter.current) {
        const reject = amazonPriceRejecter.current;
        amazonPriceResolver.current = null;
        amazonPriceRejecter.current = null;
        reject(new Error("Live Amazon price checking was stopped."));
      }
      if (detail.status === "error" && amazonPriceRejecter.current) {
        const reject = amazonPriceRejecter.current;
        amazonPriceResolver.current = null;
        amazonPriceRejecter.current = null;
        reject(new Error("The Chrome helper could not start the Amazon price check. Reload it and try again."));
      }
    }
    document.addEventListener("sellfinity:amazon-price-found", receiveAmazonPrice);
    document.addEventListener("sellfinity:amazon-product-unavailable", receiveAmazonUnavailable);
    document.addEventListener("sellfinity:amazon-price-helper-progress", receiveAmazonPriceProgress);
    return () => {
      document.removeEventListener("sellfinity:amazon-price-found", receiveAmazonPrice);
      document.removeEventListener("sellfinity:amazon-product-unavailable", receiveAmazonUnavailable);
      document.removeEventListener("sellfinity:amazon-price-helper-progress", receiveAmazonPriceProgress);
    };
  }, []);

  async function checkLiveAmazonPrices(targetRows: EbayRow[]): Promise<{ availableIds: Set<string>; unavailableIds: Set<string>; skippedFresh: number }> {
    const freshRows = skipFreshAmazon ? targetRows.filter((row) => isAmazonDataFresh(row.amazonUpdatedAt)) : [];
    const freshIds = new Set(freshRows.map((row) => row.ebayListingId));
    const rowsToCheck = targetRows.filter((row) => !freshIds.has(row.ebayListingId));
    const grouped = new Map<string, { requestKey: string; amazonUrl: string; orderIds: string[] }>();
    for (const row of rowsToCheck) {
      if (!row.match?.amazonUrl || !row.match.sku) continue;
      const requestKey = row.match.sku.trim().toUpperCase();
      const current = grouped.get(requestKey);
      if (current) current.orderIds.push(row.ebayListingId);
      else grouped.set(requestKey, {
        requestKey,
        amazonUrl: /^[A-Z0-9]{10}$/i.test(requestKey) ? `https://www.amazon.com/dp/${requestKey}` : row.match.amazonUrl,
        orderIds: [row.ebayListingId],
      });
    }
    const requests = [...grouped.values()];
    const freshAvailableIds = freshRows.filter((row) => row.match && !row.match.unavailable).map((row) => row.ebayListingId);
    const freshUnavailableIds = freshRows.filter((row) => row.match?.unavailable).map((row) => row.ebayListingId);
    amazonPriceSuccessfulIds.current = new Set(freshAvailableIds);
    amazonUnavailableIds.current = new Set(freshUnavailableIds);
    amazonPriceSkippedFresh.current = freshRows.length;
    amazonPriceSavePromises.current = [];
    if (!requests.length) {
      if (freshRows.length) {
        setAmazonPriceProgress({ status: "complete", total: 0, processed: 0, found: 0 });
        return { availableIds: new Set(freshAvailableIds), unavailableIds: new Set(freshUnavailableIds), skippedFresh: freshRows.length };
      }
      throw new Error("No matched Amazon products are available in this Smart Sync scope.");
    }
    setAmazonPriceBridgeIds(requests.flatMap((request) => request.orderIds));
    setAmazonPriceProgress({ status: "starting", total: requests.length, processed: 0, found: 0 });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    return new Promise<{ availableIds: Set<string>; unavailableIds: Set<string>; skippedFresh: number }>((resolve, reject) => {
      amazonPriceResolver.current = resolve;
      amazonPriceRejecter.current = reject;
      amazonPriceStartupTimer.current = window.setTimeout(() => {
        amazonPriceResolver.current = null;
        amazonPriceRejecter.current = null;
        setAmazonPriceProgress(null);
        reject(new Error("The Chrome helper did not respond. Reload helper v1.3.5, refresh this Sellfinity tab, then try again."));
      }, 8_000);
      document.dispatchEvent(new CustomEvent("sellfinity:bulk-amazon-price-check", { detail: { requests } }));
    });
  }

  function stopLiveAmazonPrices() {
    document.dispatchEvent(new CustomEvent("sellfinity:stop-amazon-price-check"));
  }

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

  function findReviewCandidate(row: EbayRow) {
    setNotice(null);
    setBusyId(row.ebayListingId);
    startTransition(async () => {
      try {
        const result = await findAmazonCandidateForReview({
          ebayListingId: row.ebayListingId,
          title: row.title,
          priceCents: row.priceCents,
          imageUrl: row.imageUrl,
          quantity: row.quantity,
        });
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        setRows((current) => current.map((candidate) => candidate.ebayListingId === row.ebayListingId
          ? {
              ...candidate,
              source: {
                title: result.candidate.title,
                sku: result.candidate.sku,
                imageUrl: result.candidate.imageUrl,
                category: "Imported",
                priceCents: result.candidate.amazonPriceCents,
                shippingCostCents: result.candidate.amazonShippingCents,
                url: result.candidate.amazonUrl,
                stock: 50,
              },
              match: null,
              sourceAssessment: { ...result.assessment, amazonUrl: result.candidate.amazonUrl },
            }
          : candidate));
        setNotice({ text: "Amazon candidate found. Compare the products, then approve or reject the pairing.", error: false });
      } finally {
        setBusyId(null);
      }
    });
  }

  function loadAmazonCandidateInput(row: EbayRow) {
    const amazonInput = manualAmazonInputs[row.ebayListingId]?.trim();
    if (!amazonInput) {
      setNotice({ text: "Paste an Amazon product link or enter its 10-character ASIN.", error: true });
      return;
    }
    setNotice(null);
    setBusyId(row.ebayListingId);
    startTransition(async () => {
      try {
        const result = await setAmazonCandidateFromInput({
          ebayListingId: row.ebayListingId,
          title: row.title,
          priceCents: row.priceCents,
          imageUrl: row.imageUrl,
          quantity: row.quantity,
          amazonInput,
        });
        if (!result.ok) {
          setNotice({ text: result.error, error: true });
          return;
        }
        setRows((current) => current.map((candidate) => candidate.ebayListingId === row.ebayListingId
          ? {
              ...candidate,
              source: {
                title: result.candidate.title,
                sku: result.candidate.sku,
                imageUrl: result.candidate.imageUrl,
                category: "Imported",
                priceCents: result.candidate.amazonPriceCents,
                shippingCostCents: result.candidate.amazonShippingCents,
                url: result.candidate.amazonUrl,
                stock: 50,
              },
              match: null,
              sourceAssessment: { ...result.assessment, amazonUrl: result.candidate.amazonUrl },
            }
          : candidate));
        setManualAmazonInputs((current) => ({ ...current, [row.ebayListingId]: "" }));
        setNotice({ text: "Amazon candidate loaded from your link. Review it, then approve the match.", error: false });
      } finally {
        setBusyId(null);
      }
    });
  }

  function approveReviewCandidate(row: EbayRow) {
    setNotice(null);
    setBusyId(row.ebayListingId);
    startTransition(async () => {
      try {
        const result = await approveAmazonCandidate(row.ebayListingId, row.source?.sku);
        if ("error" in result) {
          setNotice({ text: result.error ?? "Could not approve this candidate.", error: true });
          return;
        }
        const profitCents = trueProfitWithBuyerShippingCents(
          row.priceCents,
          row.buyerShippingCents ?? 0,
          result.match.amazonPriceCents,
          result.match.amazonShippingCents,
          sitewideDiscountBps,
          adRateBps,
        );
        const buyerTotal = discountedEbayPriceCents(row.priceCents, sitewideDiscountBps) + (row.buyerShippingCents ?? 0);
        setRows((current) => current.map((candidate) => candidate.ebayListingId === row.ebayListingId
          ? {
              ...candidate,
              match: {
                sku: result.match.sku,
                amazonPriceCents: result.match.amazonPriceCents,
                shippingCostCents: result.match.amazonShippingCents,
                amazonUrl: result.match.amazonUrl,
                profitCents,
                marginPct: buyerTotal > 0 ? Math.round(profitCents / buyerTotal * 100) : 0,
                unavailable: result.match.unavailable,
              },
              sourceAssessment: { ...result.assessment, amazonUrl: result.match.amazonUrl },
            }
          : candidate));
        setNotice({ text: "Amazon pairing approved and saved as Manually verified (100% confidence).", error: false });
      } finally {
        setBusyId(null);
      }
    });
  }

  function toggleAllHighConfidenceCandidates() {
    const ids = selectionRowsInView.map((row) => row.ebayListingId);
    setSelected((current) => {
      const next = new Set(current);
      const everySelected = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (everySelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function approveSelectedHighConfidenceCandidates() {
    const targets = selectedApprovalRows;
    if (!targets.length) return;
    if (!window.confirm(`Approve ${targets.length} selected Amazon candidate${targets.length === 1 ? "" : "s"} as manually verified matches?`)) return;
    setNotice(null);
    setBulkApprovalProgress({ completed: 0, total: targets.length });
    startTransition(async () => {
      let approvedCount = 0;
      let skippedCount = 0;
      try {
        for (let offset = 0; offset < targets.length; offset += 100) {
          const batch = targets.slice(offset, offset + 100);
          const result = await approveAmazonCandidatesBulk(batch.map((row) => ({
            ebayListingId: row.ebayListingId,
            expectedAsin: row.source!.sku,
          })));
          const approvedById = new Map(result.approved.map((item) => [item.ebayListingId, item]));
          approvedCount += result.approved.length;
          skippedCount += result.skipped.length;
          setRows((current) => current.map((row) => {
            const approved = approvedById.get(row.ebayListingId);
            if (!approved) return row;
            const profitCents = trueProfitWithBuyerShippingCents(
              row.priceCents,
              row.buyerShippingCents ?? 0,
              approved.match.amazonPriceCents,
              approved.match.amazonShippingCents,
              sitewideDiscountBps,
              adRateBps,
            );
            const buyerTotal = discountedEbayPriceCents(row.priceCents, sitewideDiscountBps) + (row.buyerShippingCents ?? 0);
            return {
              ...row,
              match: {
                sku: approved.match.sku,
                amazonPriceCents: approved.match.amazonPriceCents,
                shippingCostCents: approved.match.amazonShippingCents,
                amazonUrl: approved.match.amazonUrl,
                profitCents,
                marginPct: buyerTotal > 0 ? Math.round(profitCents / buyerTotal * 100) : 0,
                unavailable: approved.match.unavailable,
              },
              sourceAssessment: { ...approved.assessment, amazonUrl: approved.match.amazonUrl },
            };
          }));
          setSelected((current) => {
            const next = new Set(current);
            for (const item of result.approved) next.delete(item.ebayListingId);
            return next;
          });
          setBulkApprovalProgress({ completed: Math.min(offset + batch.length, targets.length), total: targets.length });
        }
        setNotice({
          text: `${approvedCount} candidate${approvedCount === 1 ? "" : "s"} approved as manually verified.${skippedCount ? ` ${skippedCount} changed before approval and were safely skipped.` : ""}`,
          error: approvedCount === 0,
        });
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : "Bulk candidate approval did not finish.", error: true });
      } finally {
        setBulkApprovalProgress(null);
      }
    });
  }

  function delistSelectedUnmatched() {
    const targets = selectedUnmatchedRows;
    if (!targets.length) return;
    if (!window.confirm(`Delist ${targets.length} selected unmatched item${targets.length === 1 ? "" : "s"} from eBay?\n\nThis ends the live eBay listings. Sellfinity can relist them later only if Smart Sync finds an available Amazon source and relisting is enabled.`)) return;
    setNotice(null);
    setBulkProgress({ kind: "delist", completed: 0, total: targets.length, succeeded: 0, failed: 0, status: "running" });
    startTransition(async () => {
      let succeeded = 0;
      let failed = 0;
      let firstError = "";
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        try {
          const result = await endUnmatchedEbayListing(target.ebayListingId);
          if (result.error) {
            failed++;
            firstError ||= result.error;
          } else {
            succeeded++;
            setRows((current) => current.filter((row) => row.ebayListingId !== target.ebayListingId));
            setSelected((current) => {
              const next = new Set(current);
              next.delete(target.ebayListingId);
              return next;
            });
          }
        } catch (error) {
          failed++;
          firstError ||= error instanceof Error ? error.message : "eBay could not end this listing.";
        }
        setBulkProgress({
          kind: "delist",
          completed: index + 1,
          total: targets.length,
          succeeded,
          failed,
          detail: firstError || "Ending selected unmatched listings on eBay.",
          status: index + 1 === targets.length ? "complete" : "running",
        });
      }
      setNotice({
        text: `${succeeded} unmatched listing${succeeded === 1 ? "" : "s"} delisted from eBay.${failed ? ` ${failed} could not be delisted. ${firstError}` : ""}`,
        error: failed > 0,
      });
      router.refresh();
    });
  }

  function rejectReviewCandidate(row: EbayRow) {
    setNotice(null);
    setBusyId(row.ebayListingId);
    startTransition(async () => {
      try {
        const result = await rejectAmazonCandidate(row.ebayListingId);
        if ("error" in result) {
          setNotice({ text: result.error ?? "Could not reject this candidate.", error: true });
          return;
        }
        setRows((current) => current.map((candidate) => candidate.ebayListingId === row.ebayListingId
          ? {
              ...candidate,
              match: null,
              sourceAssessment: {
                verdict: "REJECTED",
                confidence: candidate.sourceAssessment?.confidence ?? null,
                reason: "This Amazon candidate was rejected by the seller.",
                method: "MANUAL_REJECTED",
                amazonUrl: candidate.sourceAssessment?.amazonUrl ?? candidate.source?.url ?? null,
              },
            }
          : candidate));
        setNotice({ text: "Candidate rejected. You can search for another Amazon candidate.", error: false });
      } finally {
        setBusyId(null);
      }
    });
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
    if (!hasSelectedSmartSyncOption(smartSyncOptions)) {
      setNotice({ text: "Select at least one Smart Sync operation before starting.", error: true });
      return;
    }
    if (smartSyncScope === "SELECTED" && selected.size === 0) {
      setNotice({ text: "Select at least one listing or change the Smart Sync scope to all listings.", error: true });
      return;
    }
    setNotice(null);
    setBulkProgress(null);
    setSyncResults([]);
    setShowSyncResults(false);
    setSyncResultFilter("all");
    setSyncProgress({
      stage: "preparing",
      completed: 0,
      total: 0,
      successful: 0,
      errors: 0,
      needsAttention: 0,
      updated: 0,
      ended: 0,
      relisted: 0,
    });
    startTransition(async () => {
      try {
        const liveAmazonCheck = smartSyncOptions.checkLiveAmazonPrices
          ? await checkLiveAmazonPrices(smartSyncTargetRows)
          : { availableIds: new Set<string>(), unavailableIds: new Set<string>(), skippedFresh: 0 };
        const scopeIds = smartSyncScope === "SELECTED" ? [...selected] : undefined;
        const started = await prepareConfigurableSmartSync(smartSyncOptions, retryLastSyncErrorsOnly, scopeIds);
        if (started.error) throw new Error(started.error);
        const candidates = started.candidates;
        const syncTotal = candidates.length + (started.ebayRefresh ? 1 : 0);
        const totals = {
          completed: 0,
          successful: 0,
          errors: 0,
          needsAttention: 0,
          updated: 0,
          ended: 0,
          relisted: 0,
        };
        const allResults: SmartSyncItemResult[] = [];
        if (started.ebayRefresh) {
          const refresh = started.ebayRefresh;
          const refreshResult: SmartSyncItemResult = {
            listingId: "ebay-listing-cache",
            ebayListingId: null,
            title: "eBay listing data refresh",
            status: refresh.status === "success" ? "success" : "error",
            outcome: refresh.status === "success" ? "updated" : "unchanged",
            actions: refresh.status === "success"
              ? [`${refresh.cached} active listings cached`, `${refresh.localUpdated} tracked listings reconciled`, `${refresh.untracked} eBay-only listings retained`]
              : [],
            originalPriceCents: 0,
            newPriceCents: 0,
            error: refresh.error,
          };
          allResults.push(refreshResult);
          totals.completed += 1;
          if (refresh.status === "success") {
            totals.successful += 1;
            totals.updated += 1;
          } else {
            totals.errors += 1;
          }
          setSyncResults([...allResults]);
        }
        setSyncProgress({ stage: "running", total: syncTotal, ...totals });

        let cursor = 0;
        async function worker() {
          while (true) {
            const index = cursor;
            cursor += 1;
            const candidate = candidates[index];
            if (!candidate) break;

            let result: SmartSyncItemResult;
            try {
              const liveUnavailable = Boolean(candidate.ebayListingId && liveAmazonCheck.unavailableIds.has(candidate.ebayListingId));
              if (smartSyncOptions.checkLiveAmazonPrices
                && !liveUnavailable
                && (!candidate.ebayListingId || !liveAmazonCheck.availableIds.has(candidate.ebayListingId))) {
                result = {
                  listingId: candidate.listingId,
                  ebayListingId: candidate.ebayListingId,
                  title: candidate.title,
                  status: "needs_attention",
                  outcome: "unchanged",
                  actions: [],
                  originalPriceCents: 0,
                  newPriceCents: 0,
                  error: "The signed-in Amazon page did not return a current price, so this listing was left unchanged.",
                };
              } else {
                result = await processConfigurableSmartSyncItem(
                  candidate.listingId,
                  smartSyncOptions,
                  smartSyncOptions.checkLiveAmazonPrices && !liveUnavailable,
                  liveUnavailable,
                );
              }
            } catch (error) {
              result = {
                listingId: candidate.listingId,
                ebayListingId: null,
                title: candidate.title,
                status: "error",
                outcome: "unchanged",
                actions: [],
                originalPriceCents: 0,
                newPriceCents: 0,
                error: error instanceof Error ? error.message : "Smart Sync could not process this listing.",
              };
            }

            allResults.push(result);
            totals.completed += 1;
            if (result.status === "success") totals.successful += 1;
            else if (result.status === "error") totals.errors += 1;
            else totals.needsAttention += 1;
            if (result.outcome === "updated") totals.updated += 1;
            else if (result.outcome === "ended") totals.ended += 1;
            else if (result.outcome === "relisted") totals.relisted += 1;

            setSyncResults([...allResults]);
            setSyncProgress({ stage: "running", total: syncTotal, ...totals });

            if (result.ebayListingId && result.outcome === "ended") {
              setRows((current) => current.filter((row) => row.ebayListingId !== result.ebayListingId));
            } else if (result.ebayListingId && result.originalPriceCents !== result.newPriceCents) {
              setRows((current) => current.map((row) => row.ebayListingId === result.ebayListingId
                ? { ...row, priceCents: result.newPriceCents }
                : row));
            }
          }
        }
        await Promise.all(Array.from({ length: 3 }, () => worker()));

        await recordSmartSyncActivity(allResults);

        const changedPrices: CleanupItemResult[] = allResults
          .filter((result) => Boolean(result.ebayListingId) && result.status !== "error" && result.originalPriceCents !== result.newPriceCents)
          .map((result) => ({
            ebayListingId: result.ebayListingId!,
            listingId: result.listingId,
            title: result.title,
            action: "repriced",
            originalPriceCents: result.originalPriceCents,
            newPriceCents: result.newPriceCents,
            suggestedPriceCents: result.newPriceCents,
          }));
        if (changedPrices.length > 0) await recordSuggestedPriceActivity(changedPrices);

        setSyncProgress({ stage: "complete", total: syncTotal, ...totals });
        setNotice({
          text: syncTotal === 0
            ? "Smart Sync found no eligible listings for the selected operations."
            : `${retryLastSyncErrorsOnly ? "Smart Sync retry" : "Smart Sync"} complete: ${totals.successful} successful, ${totals.needsAttention} need attention, and ${totals.errors} errors. ${totals.updated} updated, ${totals.ended} ended, and ${totals.relisted} relisted.${liveAmazonCheck.skippedFresh ? ` ${liveAmazonCheck.skippedFresh} recently checked Amazon listing${liveAmazonCheck.skippedFresh === 1 ? " was" : "s were"} reused.` : ""}${liveAmazonCheck.unavailableIds.size ? ` Amazon confirmed ${liveAmazonCheck.unavailableIds.size} unavailable listing${liveAmazonCheck.unavailableIds.size === 1 ? "" : "s"}; ${smartSyncOptions.endUnavailableListings ? "eligible listings were ended automatically" : "they were flagged for your review"}.` : ""}`,
          error: totals.errors > 0,
        });
        setSmartSyncOpen(false);
        setRetryLastSyncErrorsOnly(false);
        router.refresh();
      } catch (error) {
        setSyncProgress((current) => current && ({ ...current, stage: "complete" }));
        setNotice({ text: error instanceof Error ? error.message : "Smart Sync could not start.", error: true });
      }
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
        `Sellfinity found ${toReprice.length} unlocked listing${toReprice.length === 1 ? "" : "s"} whose profitable suggested price differs from the current eBay price. It will reuse administrator-stored Amazon pricing and update only prices that still differ.${protectedWinnerCandidateCount ? `\n\n${protectedWinnerCandidateCount} profitable listing price${protectedWinnerCandidateCount === 1 ? " is" : "s are"} locked and excluded from this bulk action.` : ""}\n\nIf an ASIN is missing, one Rainforest lookup will save it to the shared admin catalog for future requests. No listings will be ended. Continue?`,
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
      `Set ${targetProfitRows.length} selected listing${targetProfitRows.length === 1 ? "" : "s"} to earn approximately ${formatCents(targetProfitCents)} net profit per sold item?\n\nThe calculation includes the shared admin Amazon price and shipping, your ${(adRateBps / 100).toFixed(2)}% ad rate, sitewide discount, estimated eBay final-value fee, and per-order fee.\n\nIf an ASIN is missing, one Rainforest lookup will save it for all future requests.`,
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

  const unmatched = rows.filter((r) => !r.match && r.sourceAssessment?.method !== "MANUAL").length;
  const highConfidenceCandidates = rows.filter(isHighConfidenceReview).length;
  const latestMarketUpdate = rows.reduce<string | null>((latest, row) => {
    if (!row.marketUpdatedAt) return latest;
    return !latest || new Date(row.marketUpdatedAt) > new Date(latest) ? row.marketUpdatedAt : latest;
  }, null);

  return (
    <div className="space-y-4">
      <div className="hidden" aria-hidden="true">
        {rows.filter((row) => amazonPriceBridgeIds.includes(row.ebayListingId) && row.match).map((row) => (
          <a
            key={`listing-amazon-price-${row.ebayListingId}`}
            data-amazon-price-check="true"
            data-order-id={row.ebayListingId}
            data-request-key={row.match!.sku.trim().toUpperCase()}
            href={/^[A-Z0-9]{10}$/i.test(row.match!.sku) ? `https://www.amazon.com/dp/${row.match!.sku}` : row.match!.amazonUrl}
          >Check Amazon price</a>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { id: "all" as const, label: "Active listings", value: rows.length, tone: "text-slate-950" },
          { id: "attention" as const, label: "Need attention", value: problems, tone: "text-red-600" },
          { id: "protected" as const, label: "Price protected", value: rows.filter((row) => row.verifiedWinner || row.priceLocked).length, tone: "text-amber-600" },
          { id: "unmatched" as const, label: "Unmatched review", value: unmatched, tone: "text-indigo-600" },
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
              <option value="unmatched">Unmatched review</option>
              <option value="highConfidence">95–100% candidates</option>
              <option value="unprofitable">Unprofitable</option>
              <option value="needsPricing">Needs pricing</option>
              <option value="recentSales">Sold in last 7 days</option>
            </select>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" aria-label="Items per page">
              <option value={25}>25 per page</option><option value={50}>50 per page</option><option value={100}>100 per page</option>
            </select>
            <Button size="sm" disabled={pending} onClick={() => setSmartSyncOpen((current) => !current)} className="col-span-2 h-11 border-0 bg-gradient-to-r from-indigo-600 to-violet-600 px-4 text-white shadow-md shadow-indigo-200/70 hover:from-indigo-500 hover:to-violet-500 sm:col-auto">
              <SmartSyncIcon spinning={syncProgress !== null && syncProgress.stage !== "complete"} />
              {syncProgress && syncProgress.stage !== "complete" ? "Syncing…" : smartSyncOpen ? "Close Smart Sync" : "Smart Sync"}
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
            ["highConfidence", `95–100% candidates (${highConfidenceCandidates})`],
          ].map(([id, label]) => (
            <button key={id} type="button" onClick={() => { setHealthFilter(id as typeof healthFilter); setPage(1); }} className={cx("shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition", healthFilter === id ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:text-indigo-700")}>{label}</button>
          ))}
        </div>
        {protectedWinnerCandidateCount > 0 && <p className="mt-2 text-[11px] text-amber-700">🔒 {protectedWinnerCandidateCount} profitable price{protectedWinnerCandidateCount === 1 ? " is" : "s are"} protected and excluded from automatic price changes.</p>}
      </Card>

      {smartSyncOpen && (
        <Card className="overflow-hidden border-indigo-200 bg-gradient-to-br from-white via-white to-indigo-50/70 p-0 shadow-lg shadow-indigo-950/5 animate-fade-in">
          <div className="flex flex-col gap-3 border-b border-indigo-100 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm"><SmartSyncIcon /></span>
                <div>
                  <h3 className="font-semibold text-slate-900">Configure Smart Sync</h3>
                  <p className="text-xs text-slate-500">Choose exactly what this run may change.</p>
                </div>
              </div>
              <p className="mt-3 max-w-3xl text-xs leading-5 text-slate-600">Administrator data remains the normal shared source. Enable live Amazon checking when you want the signed-in Chrome helper to verify current item price and shipping before Smart Sync calculates profit.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2"><a href="/downloads/sellfinity-tracking-helper.zip?v=1.3.5" download className="text-xs font-semibold text-indigo-700 hover:underline">Chrome helper v1.3.5</a><Badge tone="indigo">{selectedSmartSyncOptionCount(smartSyncOptions)} selected</Badge></div>
          </div>
          <div className="border-b border-slate-100 bg-white/70 px-4 py-3 sm:px-5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">Run on</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setSmartSyncScope("ALL")} className={cx("rounded-lg border px-3 py-2 text-xs font-semibold transition", smartSyncScope === "ALL" ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200")}>All {rows.length.toLocaleString()} listings</button>
              <button type="button" disabled={selected.size === 0} onClick={() => setSmartSyncScope("SELECTED")} className={cx("rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40", smartSyncScope === "SELECTED" ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200")}>Selected {selected.size.toLocaleString()}</button>
            </div>
          </div>
          <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
            {SMART_SYNC_OPTION_META.map((option) => (
              <label key={option.key} className={cx("group flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md", smartSyncOptions[option.key] ? "border-indigo-300 bg-indigo-50/70 shadow-sm shadow-indigo-950/5" : "border-slate-200 bg-white hover:border-indigo-200")}>
                <span className="relative mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
                  <input
                    type="checkbox"
                    checked={smartSyncOptions[option.key]}
                    onChange={(event) => setSmartSyncOptions((current) => ({ ...current, [option.key]: event.target.checked }))}
                    className="peer h-5 w-5 appearance-none rounded-md border border-slate-300 bg-white transition checked:border-indigo-600 checked:bg-indigo-600 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                  />
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="pointer-events-none absolute h-3.5 w-3.5 scale-75 text-white opacity-0 transition peer-checked:scale-100 peer-checked:opacity-100"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-800">{option.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
          {smartSyncOptions.checkLiveAmazonPrices && (
            <div className="border-t border-indigo-100 bg-indigo-50/40 px-4 py-3 sm:px-5">
              <label className="flex cursor-pointer items-start gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={skipFreshAmazon} onChange={(event) => setSkipFreshAmazon(event.target.checked)} disabled={pending} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                <span>Skip Amazon products checked in the last 24 hours <span className="block pt-0.5 font-normal text-slate-500">Fresh saved prices, shipping, and availability will be reused.</span></span>
              </label>
            </div>
          )}
          {amazonPriceProgress && smartSyncOptions.checkLiveAmazonPrices && (
            <div className="border-t border-violet-100 bg-violet-50/70 px-4 py-3 sm:px-5" role="status" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-medium text-violet-900"><span>{amazonPriceProgress.status === "complete" ? "Live Amazon prices checked" : amazonPriceProgress.status === "cancelled" ? "Live Amazon price check stopped" : amazonPriceProgress.status === "error" ? "Live Amazon price check could not start" : "Checking signed-in Amazon prices and shipping…"}</span><span className="flex items-center gap-2"><span>{amazonPriceProgress.processed}/{amazonPriceProgress.total} · {amazonPriceProgress.found} found</span>{(amazonPriceProgress.status === "starting" || amazonPriceProgress.status === "running") && <Button size="sm" variant="danger" onClick={stopLiveAmazonPrices}>Stop check</Button>}</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-violet-100"><div className="h-full rounded-full bg-violet-600 transition-all duration-500" style={{ width: `${amazonPriceProgress.total ? Math.max(5, amazonPriceProgress.processed / amazonPriceProgress.total * 100) : 5}%` }} /></div>
            </div>
          )}
          <div className="flex flex-col gap-3 border-t border-slate-100 bg-white/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={retryLastSyncErrorsOnly} onChange={(event) => setRetryLastSyncErrorsOnly(event.target.checked)} disabled={pending} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                Retry only errors from the last Smart Sync
              </label>
              <p className="text-[11px] leading-5 text-slate-500">Price-protected and verified-winner listings remain locked unless you change them separately with confirmation.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={pending} onClick={() => setSmartSyncOptions({ ...DEFAULT_SMART_SYNC_OPTIONS })} className="rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50">Recommended</button>
              <button type="button" disabled={pending} onClick={() => setSmartSyncOptions({ refreshEbayListings: true, refreshAmazonData: true, checkLiveAmazonPrices: true, applySuggestedPrices: true, updateListingImages: true, endUnavailableListings: true, relistRecoveredProducts: true })} className="rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50">Select all</button>
              <Button disabled={pending || !hasSelectedSmartSyncOption(smartSyncOptions) || (smartSyncScope === "SELECTED" && selected.size === 0)} onClick={syncListingHealth} className="min-w-36 border-0 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-200/70 hover:from-indigo-500 hover:to-violet-500">
                <SmartSyncIcon spinning={pending} />
                {pending ? "Syncing…" : retryLastSyncErrorsOnly ? "Retry last errors" : "Run Smart Sync"}
              </Button>
            </div>
          </div>
        </Card>
      )}

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
                Sets the minimum eBay price needed to reach your chosen profit per sold item. Shared Amazon data is reused; only a first-seen ASIN needs one Rainforest lookup.
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
      ) : syncProgress && (
        <SmartSyncStatus
          progress={syncProgress}
          results={syncResults}
          showResults={showSyncResults}
          resultFilter={syncResultFilter}
          onToggleResults={() => setShowSyncResults((current) => !current)}
          onResultFilterChange={setSyncResultFilter}
        />
      )}

      {fetchError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Couldn&apos;t load your eBay listings: {fetchError}
        </p>
      )}

      {(healthFilter === "unmatched" || healthFilter === "highConfidence") && (
        <Card className="overflow-hidden border-indigo-200">
          <div className="border-b border-indigo-100 bg-gradient-to-r from-indigo-50 via-white to-violet-50 px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="font-semibold text-slate-950">{healthFilter === "highConfidence" ? "High-confidence candidate review" : "Unmatched source review"}</h2><p className="mt-1 text-xs leading-5 text-slate-600">{healthFilter === "highConfidence" ? "Every non-verified Amazon candidate with 95–100% confidence is shown, including automatically matched items. Select the matches you agree with, then approve them together." : "Compare the eBay item with its Amazon candidate. Approval permanently records this pairing as manually verified with 100% confidence."}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="indigo">{filteredRows.length.toLocaleString()} {healthFilter === "highConfidence" ? "high confidence" : "unmatched"}</Badge>
                {selectionRowsInView.length > 0 && <>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                    <input type="checkbox" checked={allApprovalRowsSelected} onChange={toggleAllHighConfidenceCandidates} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    {healthFilter === "highConfidence" ? `Select all ${selectionRowsInView.length.toLocaleString()} at 95–100%` : `Select all ${selectionRowsInView.length.toLocaleString()} unmatched`}
                  </label>
                  {selectedApprovalRows.length > 0 && <Button size="sm" disabled={pending} onClick={approveSelectedHighConfidenceCandidates}>{bulkApprovalProgress ? `Approving ${bulkApprovalProgress.completed}/${bulkApprovalProgress.total}` : `Approve candidates (${selectedApprovalRows.length})`}</Button>}
                  {healthFilter === "unmatched" && selectedUnmatchedRows.length > 0 && <Button size="sm" variant="danger" disabled={pending} onClick={delistSelectedUnmatched}>{bulkProgress?.kind === "delist" && bulkProgress.status === "running" ? `Delisting ${bulkProgress.completed}/${bulkProgress.total}` : `Delist selected (${selectedUnmatchedRows.length})`}</Button>}
                </>}
              </div>
            </div>
          </div>
          <div className="grid gap-3 bg-slate-50/60 p-3 lg:grid-cols-2 lg:p-4">
            {visibleRows.map((row) => {
              const review = row.sourceAssessment;
              const rejected = review?.verdict === "REJECTED";
              const sellerRejected = rejected && review?.method === "MANUAL_REJECTED";
              return (
                <article key={`review-${row.ebayListingId}`} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="grid gap-0 sm:grid-cols-2">
                    <div className="border-b border-slate-100 p-4 sm:border-b-0 sm:border-r">
                      <div className="flex items-center justify-between gap-2"><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">eBay listing</p>{(healthFilter === "unmatched" || isHighConfidenceReview(row)) && <input type="checkbox" checked={selected.has(row.ebayListingId)} onChange={() => toggleSelected(row.ebayListingId)} aria-label={`Select ${row.title}`} className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />}</div>
                      <div className="mt-3 flex gap-3">
                        {row.imageUrl ? <>
                          {/* eslint-disable-next-line @next/next/no-img-element -- External marketplace image hosts are dynamic. */}
                          <img src={row.imageUrl} alt="" className="h-20 w-20 shrink-0 rounded-xl border border-slate-200 object-contain" />
                        </> : <div className="h-20 w-20 shrink-0 rounded-xl bg-slate-100" />}
                        <div className="min-w-0"><a href={row.url} target="_blank" rel="noreferrer" className="line-clamp-4 text-sm font-semibold leading-5 text-slate-900 hover:text-indigo-700">{row.title}</a><p className="mt-2 text-xs font-medium text-slate-500">{formatCents(row.priceCents)} · #{row.ebayListingId}</p></div>
                      </div>
                    </div>
                    <div className="p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">Amazon candidate</p>
                      {row.source && review ? (
                        <div className="mt-3 flex gap-3">
                          {row.source.imageUrl ? <>
                            {/* eslint-disable-next-line @next/next/no-img-element -- External marketplace image hosts are dynamic. */}
                            <img src={row.source.imageUrl} alt="" className="h-20 w-20 shrink-0 rounded-xl border border-slate-200 object-contain" />
                          </> : <div className="h-20 w-20 shrink-0 rounded-xl bg-slate-100" />}
                          <div className="min-w-0"><a href={row.source.url} target="_blank" rel="noreferrer" className="line-clamp-4 text-sm font-semibold leading-5 text-slate-900 hover:text-indigo-700">{row.source.title}</a><p className="mt-2 text-xs font-medium text-slate-500">{formatCents(row.source.priceCents + row.source.shippingCostCents)} · {row.source.sku}</p></div>
                        </div>
                      ) : <div className="mt-3 grid min-h-20 place-items-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-xs text-slate-500">No candidate researched yet</div>}
                    </div>
                  </div>
                  {review && (
                    <div className={cx("border-t px-4 py-3", rejected ? "border-red-100 bg-red-50/70" : "border-amber-100 bg-amber-50/70")}>
                      <div className="flex flex-wrap items-center gap-2"><Badge tone={rejected ? "red" : "amber"}>{sellerRejected ? "Previously rejected by you" : rejected ? `${review.confidence ?? 0}% confidence this is not a match` : `${review.confidence ?? 0}% candidate confidence`}</Badge>{review.method && !review.method.startsWith("MANUAL") && <Badge tone="slate">{review.method === "AI" ? "AI assessed" : "Rules assessed"}</Badge>}</div>
                      <p className="mt-2 text-xs leading-5 text-slate-600">{review.reason}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3">
                    {!review ? <Button size="sm" variant="secondary" disabled={pending || busyId === row.ebayListingId} onClick={() => findReviewCandidate(row)}>{busyId === row.ebayListingId ? "Searching Amazon…" : "Find best candidate"}</Button> : <><Button size="sm" disabled={pending || busyId === row.ebayListingId} onClick={() => approveReviewCandidate(row)}>{busyId === row.ebayListingId ? "Saving…" : rejected ? "Approve anyway" : "Approve match"}</Button>{rejected && <Button size="sm" variant="secondary" disabled={pending || busyId === row.ebayListingId} onClick={() => findReviewCandidate(row)}>{busyId === row.ebayListingId ? "Searching…" : "Find best candidate"}</Button>}{healthFilter === "unmatched" && review.verdict === "REVIEW" && <Button size="sm" variant="secondary" disabled={pending || busyId === row.ebayListingId} onClick={() => rejectReviewCandidate(row)}>Reject candidate</Button>}</>}
                    {healthFilter === "unmatched" && <Button size="sm" variant="danger" disabled={pending || busyId === row.ebayListingId} onClick={() => { if (!window.confirm(`Delist "${row.title.slice(0, 60)}" from eBay because it has no approved Amazon source?`)) return; run(row.ebayListingId, () => endUnmatchedEbayListing(row.ebayListingId), () => { setRows((current) => current.filter((item) => item.ebayListingId !== row.ebayListingId)); setSelected((current) => { const next = new Set(current); next.delete(row.ebayListingId); return next; }); }, "Unmatched listing delisted from eBay."); }}>{busyId === row.ebayListingId ? "Delisting…" : "Delist"}</Button>}
                    {row.source?.url && <a href={row.source.url} target="_blank" rel="noreferrer" className="ml-auto text-xs font-semibold text-indigo-700 hover:underline">Open Amazon ↗</a>}
                    <details className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
                      <summary className="cursor-pointer text-xs font-semibold text-indigo-700">Use an Amazon link or ASIN instead</summary>
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <input
                          value={manualAmazonInputs[row.ebayListingId] ?? ""}
                          onChange={(event) => setManualAmazonInputs((current) => ({ ...current, [row.ebayListingId]: event.target.value }))}
                          onKeyDown={(event) => { if (event.key === "Enter") loadAmazonCandidateInput(row); }}
                          placeholder="Paste Amazon product link or ASIN"
                          aria-label={`Amazon link or ASIN for ${row.title}`}
                          className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                        />
                        <Button size="sm" disabled={pending || busyId === row.ebayListingId} onClick={() => loadAmazonCandidateInput(row)}>{busyId === row.ebayListingId ? "Loading…" : "Use this product"}</Button>
                      </div>
                      <p className="mt-2 text-[11px] leading-4 text-slate-500">The exact ASIN is loaded from the shared admin catalog. A first-seen ASIN is fetched once and saved for future use.</p>
                    </details>
                  </div>
                </article>
              );
            })}
          </div>
          {visibleRows.length === 0 && <div className="px-5 py-14 text-center"><p className="font-semibold text-slate-900">{healthFilter === "highConfidence" ? "No unverified 95–100% candidates found" : "No unmatched listings in this view"}</p><p className="mt-1 text-sm text-slate-500">Clear the search or return to All listings.</p></div>}
          {pageCount > 1 && <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-3"><Button size="sm" variant="secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button><span className="text-xs font-medium text-slate-500">Page {currentPage} of {pageCount}</span><Button size="sm" variant="secondary" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</Button></div>}
        </Card>
      )}

      {expandedTable && (
        <div className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-sm" />
      )}
      <Card
        className={cx(
          "min-w-0 overflow-hidden",
          (healthFilter === "unmatched" || healthFilter === "highConfidence") && "hidden",
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
                      <p className="mt-0.5 text-[9px] text-slate-400">{r.amazonUpdatedAt ? formatFreshness(r.amazonUpdatedAt) : "Not checked yet"}</p>
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
                          {r.sourceAssessment && <Badge tone={r.sourceAssessment.method === "MANUAL" || (r.sourceAssessment.confidence !== null && r.sourceAssessment.confidence >= 95) ? "green" : "amber"}>{matchAssessmentLabel(r.sourceAssessment)}</Badge>}
                          <Badge tone={(r.buyerShippingCents ?? 0) > 0 ? "indigo" : "slate"}>{(r.buyerShippingCents ?? 0) > 0 ? `${formatCents(r.buyerShippingCents ?? 0)} shipping` : r.shippingStrategy ? "Free shipping" : "Shipping unknown"}</Badge>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="min-w-[170px] px-4 py-4 text-sm text-slate-700">{r.source?.category ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums">
                    {r.source ? <>{formatCents(r.source.priceCents + r.source.shippingCostCents)}<p className="mt-0.5 text-[11px] font-normal text-slate-500">{formatCents(r.source.priceCents)}{r.source.shippingCostCents > 0 ? ` + ${formatCents(r.source.shippingCostCents)} shipping` : " · free shipping"}</p><p className="mt-0.5 text-[10px] font-normal text-slate-400">{r.amazonUpdatedAt ? formatFreshness(r.amazonUpdatedAt) : "Not checked yet"}</p></> : "—"}
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
                          {matchAssessmentLabel(r.sourceAssessment)}
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
