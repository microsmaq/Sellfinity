"use client";

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

function ListingOperationStatus({ progress }: { progress: ListingOperationProgress }) {
  const percentage = progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : progress.status === "complete" ? 100 : 4;
  const meta = {
    enhance: ["AI-enhancing selected listings", "Generating premium imagery and optimizing enabled listing content."],
    match: ["Matching listings to Amazon sources", "Comparing product identity and exact variants for each listing."],
    pricing: ["Applying profitable suggested prices", "Using administrator-stored Amazon costs before updating each eBay listing."],
    targetProfit: ["Applying target-profit prices", "Calculating the minimum eBay price that reaches your requested modeled net profit."],
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
       …14892 tokens truncated…after ads" value="profit" active={sortKey === "profit"} descending={sortDescending} onSort={sortBy} />
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

