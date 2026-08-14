"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  createDrafts,
  deleteDrafts,
  endListings,
  publishListings,
  updateListing,
  type BulkResult,
} from "@/lib/actions/listings";
import { assessPriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { estimateMargin } from "@/lib/fees";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";
import { EbayListingsTable, type EbayRow } from "./ebay-listings-table";

export type UnlistedRow = {
  productId: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  costCents: number;
  suggestedPriceCents: number;
  supplierStock: number;
};

export type ListingRow = {
  id: string;
  title: string;
  sku: string;
  imageUrl: string | null;
  priceCents: number;
  quantity: number;
  costCents: number;
  shippingCostCents: number;
  supplierStock: number;
  supplierUrl: string;
  category: string;
  suggestedPriceCents: number;
  status: "DRAFT" | "ACTIVE" | "ENDED";
  ebayListingId: string | null;
  ebayUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  sourceMatchVerdict: string;
  sourceMatchConfidence: number | null;
  sourceMatchReason: string | null;
  estimatedSales30d: number | null;
  competitorCount: number | null;
  averageCompetitorPriceCents: number | null;
  ebayRecommendedPriceCents: number | null;
};

type Tab = "ebay" | "unlisted" | "DRAFT" | "ACTIVE" | "ENDED";

const statusTone = { DRAFT: "amber", ACTIVE: "green", ENDED: "slate" } as const;

function Thumb({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 bg-white object-contain"
    />
  ) : (
    <div className="h-16 w-16 shrink-0 rounded-lg bg-slate-100" />
  );
}

function CellValue({
  value,
  suffix = "",
}: {
  value: number | null;
  suffix?: string;
}) {
  return value === null ? (
    <span className="text-slate-400">-</span>
  ) : (
    <span className="tabular-nums">{value.toLocaleString()}{suffix}</span>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function confidenceTone(value: number | null): "green" | "amber" | "red" | "slate" {
  if (value === null) return "slate";
  if (value >= 95) return "green";
  if (value >= 75) return "amber";
  return "red";
}

function PriceQuantityCell({
  listing,
  onDone,
  onLocalChange,
}: {
  listing: ListingRow;
  onDone: (r: BulkResult) => void;
  onLocalChange: (update: { priceCents?: number; quantity?: number }) => void;
}) {
  const [price, setPrice] = useState((listing.priceCents / 100).toFixed(2));
  const [qty, setQty] = useState(String(listing.quantity));
  const [pending, startTransition] = useTransition();

  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <input
        value={price}
        onChange={(e) => {
          const next = e.target.value;
          setPrice(next);
          const cents = parseDollarsToCents(next);
          if (cents !== null) onLocalChange({ priceCents: cents });
        }}
        className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right text-xs tabular-nums focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        aria-label="Price (dollars)"
      />
      <input
        value={qty}
        onChange={(e) => {
          const next = e.target.value;
          setQty(next);
          if (/^\d+$/.test(next.trim())) {
            onLocalChange({ quantity: parseInt(next.trim(), 10) });
          }
        }}
        className="w-14 rounded-md border border-slate-300 px-2 py-1.5 text-right text-xs tabular-nums focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        aria-label="Quantity"
      />
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          const priceCents = parseDollarsToCents(price);
          const quantity = /^\d+$/.test(qty.trim()) ? parseInt(qty.trim(), 10) : null;
          if (priceCents === null || quantity === null) {
            onDone({ done: 0, failed: 1, error: "Enter a valid price and quantity" });
            return;
          }
          startTransition(async () => {
            onDone(await updateListing(listing.id, { priceCents, quantity }));
          });
        }}
      >
        Save
      </Button>
    </span>
  );
}

function ListingMarketRow({
  row,
  sitewideDiscountBps,
  selected,
  onToggle,
  onLocalChange,
  onUpdateDone,
}: {
  row: ListingRow;
  sitewideDiscountBps: number;
  selected: boolean;
  onToggle: () => void;
  onLocalChange: (id: string, update: { priceCents?: number; quantity?: number }) => void;
  onUpdateDone: (result: BulkResult) => void;
}) {
  const landedCostCents = row.costCents + row.shippingCostCents;
  const margin = estimateMargin(
    row.priceCents,
    row.costCents,
    row.shippingCostCents,
    sitewideDiscountBps,
  );
  const competitiveness = assessPriceCompetitiveness(
    row.priceCents,
    row.priceCents,
    row.averageCompetitorPriceCents,
    row.ebayRecommendedPriceCents,
    row.suggestedPriceCents,
    sitewideDiscountBps,
  );
  const rowDate = row.publishedAt ?? row.createdAt;

  return (
    <tr className="group border-t border-slate-100 align-top hover:bg-slate-50/70">
      <td className="sticky left-0 z-10 w-12 bg-white px-3 py-5 group-hover:bg-slate-50">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.title}`}
          className="h-4 w-4 rounded border-slate-300 text-indigo-600"
        />
      </td>
      <td className="sticky left-12 z-10 min-w-[410px] bg-white px-5 py-4 group-hover:bg-slate-50">
        <div className="flex gap-3">
          <Thumb url={row.imageUrl} />
          <div className="min-w-0">
            {row.status === "ACTIVE" && row.ebayUrl ? (
              <a
                href={row.ebayUrl}
                target="_blank"
                rel="noreferrer"
                className="line-clamp-3 text-sm font-semibold leading-5 text-slate-900 hover:text-indigo-600"
                title={`View ${row.title} on eBay`}
              >
                {row.title}
              </a>
            ) : (
              <p className="line-clamp-3 text-sm font-semibold leading-5 text-slate-900" title={row.title}>
                {row.title}
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">SKU {row.sku}</p>
            <Link
              href={`/analytics/asins/${encodeURIComponent(row.sku)}`}
              className="mt-1 inline-block text-xs font-semibold text-indigo-600 hover:underline"
            >
              View performance
            </Link>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge tone={statusTone[row.status]}>{row.status}</Badge>
              <Badge tone={confidenceTone(row.sourceMatchConfidence)}>
                {row.sourceMatchVerdict}
                {row.sourceMatchConfidence !== null ? ` ${row.sourceMatchConfidence}%` : ""}
              </Badge>
            </div>
          </div>
        </div>
      </td>
      <td className="min-w-[170px] px-4 py-4 text-sm text-slate-700">{row.category}</td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums">
        {formatCents(landedCostCents)}
        <p className="mt-0.5 text-[11px] font-normal text-slate-500">
          {formatCents(row.costCents)}
          {row.shippingCostCents > 0
            ? ` + ${formatCents(row.shippingCostCents)} shipping`
            : " · free shipping"}
        </p>
      </td>
      <td className="min-w-[260px] px-4 py-4">
        <a
          href={row.supplierUrl}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-2 text-sm font-medium text-slate-800 hover:text-indigo-600"
        >
          Amazon source
        </a>
        <p className="mt-1 text-xs text-slate-500">
          Stock {row.supplierStock.toLocaleString()}
        </p>
        {row.sourceMatchReason && (
          <p className="mt-1 line-clamp-2 text-xs text-slate-500">{row.sourceMatchReason}</p>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-medium tabular-nums">
        <PriceQuantityCell
          listing={row}
          onLocalChange={(update) => onLocalChange(row.id, update)}
          onDone={onUpdateDone}
        />
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.averageCompetitorPriceCents === null ? "-" : formatCents(row.averageCompetitorPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.ebayRecommendedPriceCents === null ? "-" : formatCents(row.ebayRecommendedPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold text-indigo-700">
        {formatCents(row.suggestedPriceCents)}
      </td>
      <td className="min-w-[260px] px-4 py-4">
        <Badge tone={competitiveness.tone}>{competitiveness.label}</Badge>
        <p className="mt-1.5 text-xs leading-4 text-slate-500">{competitiveness.summary}</p>
      </td>
      <td className="px-4 py-4 text-right"><CellValue value={row.estimatedSales30d} /></td>
      <td className="px-4 py-4 text-right"><CellValue value={row.competitorCount} /></td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        <span className={margin.estimatedProfitCents > 0 ? "font-semibold text-emerald-700" : "text-red-600"}>
          {formatCents(margin.estimatedProfitCents)}
        </span>
      </td>
      <td className="px-4 py-4 text-right">
        <span className={margin.marginPct >= 15 ? "font-semibold text-emerald-700" : "text-amber-700"}>
          {Math.round(margin.marginPct)}%
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{formatDate(rowDate)}</td>
      <td className="sticky right-0 min-w-[150px] bg-white px-4 py-4 text-xs text-slate-500 group-hover:bg-slate-50">
        {row.ebayUrl ? (
          <a
            href={row.ebayUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-600 hover:underline"
          >
            {row.ebayListingId}
          </a>
        ) : (
          row.ebayListingId ?? "-"
        )}
      </td>
    </tr>
  );
}

export function ListingsView({
  unlisted,
  listings,
  ebayConnected,
  ebayRows,
  ebayFetchError,
  improveMainImage,
  improveListingContent,
  sitewideDiscountBps,
}: {
  unlisted: UnlistedRow[];
  listings: ListingRow[];
  ebayConnected: boolean;
  ebayRows: EbayRow[];
  ebayFetchError: string | null;
  improveMainImage: boolean;
  improveListingContent: boolean;
  sitewideDiscountBps: number;
}) {
  const [tab, setTab] = useState<Tab>(ebayConnected ? "ebay" : "unlisted");
  const [listingRows, setListingRows] = useState(listings);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [expandedTable, setExpandedTable] = useState(false);
  const [actionProgress, setActionProgress] = useState<{
    title: string;
    total: number;
    done: number;
    failed: number;
    complete: boolean;
  } | null>(null);

  const byStatus = useMemo(() => {
    const map = { DRAFT: [] as ListingRow[], ACTIVE: [] as ListingRow[], ENDED: [] as ListingRow[] };
    for (const l of listingRows) map[l.status].push(l);
    return map;
  }, [listingRows]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "ebay", label: "Active on eBay", count: ebayRows.length },
    { id: "unlisted", label: "Unlisted inventory", count: unlisted.length },
    { id: "DRAFT", label: "Drafts", count: byStatus.DRAFT.length },
    { id: "ACTIVE", label: "Active", count: byStatus.ACTIVE.length },
    { id: "ENDED", label: "Ended", count: byStatus.ENDED.length },
  ];

  const currentIds =
    tab === "ebay"
      ? []
      : tab === "unlisted"
        ? unlisted.map((u) => u.productId)
        : byStatus[tab].map((l) => l.id);
  const allSelected =
    currentIds.length > 0 && currentIds.every((id) => selected.has(id));

  function switchTab(t: Tab) {
    setTab(t);
    setSelected(new Set());
    setNotice(null);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function report(result: BulkResult, verb: string, title: string, total: number) {
    setActionProgress({ title, total, done: result.done, failed: result.failed, complete: true });
    if (result.error) {
      setNotice({
        text: result.error + (result.done ? ` (${result.done} ${verb})` : ""),
        error: true,
      });
    } else {
      setNotice({
        text: `${result.done} listing${result.done === 1 ? "" : "s"} ${verb}${result.failed ? `, ${result.failed} skipped` : ""}`,
        error: false,
      });
    }
    setSelected(new Set());
  }

  function run(fn: (ids: string[]) => Promise<BulkResult>, verb: string) {
    const ids = [...selected];
    const title = verb === "published"
      ? "Publishing listings to eBay"
      : verb === "drafted"
        ? "Generating listing drafts"
        : verb === "ended"
          ? "Ending eBay listings"
          : "Updating selected listings";
    setNotice(null);
    setActionProgress({ title, total: ids.length, done: 0, failed: 0, complete: false });
    startTransition(async () => report(await fn(ids), verb, title, ids.length));
  }

  const bulkActions = (
    <div className="flex items-center gap-2">
      {tab === "unlisted" && (
        <Button
          disabled={pending || selected.size === 0}
          onClick={() => run(createDrafts, "drafted")}
        >
          {pending ? "Working…" : `Generate drafts (${selected.size})`}
        </Button>
      )}
      {tab === "DRAFT" && (
        <>
          <Button
            disabled={pending || selected.size === 0 || !ebayConnected}
            onClick={() => run(publishListings, "published")}
            title={ebayConnected ? undefined : "Connect eBay in Settings first"}
          >
            {pending ? "Working…" : `Publish to eBay (${selected.size})`}
          </Button>
          <Button
            variant="secondary"
            disabled={pending || selected.size === 0}
            onClick={() => run(deleteDrafts, "deleted")}
          >
            Delete
          </Button>
        </>
      )}
      {tab === "ACTIVE" && (
        <Button
          variant="danger"
          disabled={pending || selected.size === 0}
          onClick={() => run(endListings, "ended")}
        >
          {pending ? "Working…" : `End listings (${selected.size})`}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              className={cx(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900",
              )}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        {bulkActions}
      </div>

      {actionProgress && (
        <PremiumProgress
          title={actionProgress.complete ? `${actionProgress.title} complete` : actionProgress.title}
          subtitle={actionProgress.complete
            ? "The result has been saved to your publishing history."
            : "Sellfinity is processing the selected items and recording each result."}
          percentage={actionProgress.complete ? 100 : undefined}
          status={actionProgress.complete ? (actionProgress.failed > 0 ? "error" : "complete") : "running"}
          stats={[
            { label: "selected", value: actionProgress.total },
            { label: "successful", value: actionProgress.done, tone: "success" },
            ...(actionProgress.failed ? [{ label: "failed", value: actionProgress.failed, tone: "danger" as const }] : []),
          ]}
        />
      )}

      {notice && (
        <p
          className={cx(
            "rounded-lg px-3 py-2 text-sm",
            notice.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
          )}
        >
          {notice.text}
        </p>
      )}

      {tab === "ebay" ? (
        <EbayListingsTable
          rows={ebayRows}
          fetchError={ebayFetchError}
          improveMainImage={improveMainImage}
          improveListingContent={improveListingContent}
          sitewideDiscountBps={sitewideDiscountBps}
        />
      ) : (
      <>
      {tab !== "unlisted" && expandedTable && (
        <div className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-sm" />
      )}
      <Card
        className={cx(
          tab === "unlisted" ? "overflow-x-auto" : "min-w-0 overflow-hidden",
          tab !== "unlisted" && expandedTable &&
            "fixed inset-3 z-50 flex flex-col rounded-2xl border-slate-300 shadow-2xl",
        )}
      >
        {tab !== "unlisted" && (
          <div className="border-b border-slate-200 bg-white px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-900">Listing intelligence</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Compare Amazon cost, market pricing, demand, competition, and live profitability.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {byStatus[tab].length.toLocaleString()} listings
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
        )}
        {tab === "unlisted" ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">
                  <input type="checkbox" checked={allSelected} onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(currentIds))
                  } aria-label="Select all" />
                </th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3 text-right">Cost</th>
                <th className="px-4 py-3 text-right">Suggested price</th>
                <th className="px-4 py-3 text-right">Supplier stock</th>
              </tr>
            </thead>
            <tbody>
              {unlisted.map((u) => (
                <tr key={u.productId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(u.productId)}
                      onChange={() => toggle(u.productId)}
                      aria-label={`Select ${u.title}`}
                    />
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Thumb url={u.imageUrl} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900">{u.title}</p>
                        <p className="text-xs text-slate-500">SKU {u.sku}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCents(u.costCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCents(u.suggestedPriceCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{u.supplierStock}</td>
                </tr>
              ))}
              {unlisted.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-slate-500">
                    Nothing unlisted. Import products from{" "}
                    <Link href="/sourcing" className="font-medium text-indigo-600">
                      Product sourcing
                    </Link>{" "}
                    to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <div
            className={cx(
              "overflow-auto",
              expandedTable ? "min-h-0 flex-1" : "max-h-[72vh]",
            )}
          >
          <table className="w-full min-w-[2550px] text-sm">
            <thead className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="sticky left-0 top-0 z-50 w-12 bg-slate-50 px-3 py-3">
                  <input type="checkbox" checked={allSelected} onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(currentIds))
                  } aria-label="Select all" />
                </th>
                <th className="sticky left-12 top-0 z-40 bg-slate-50 px-5 py-3 text-left">Listing</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Category</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Amazon landed</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Source match</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Listing price / qty</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Competitor avg</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">eBay recommended</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">AI suggested</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Price assessment</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Sales / month</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Competition</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Profit after ads</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-right">Margin</th>
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Listing date</th>
                <th className="sticky right-0 top-0 z-40 bg-slate-50 px-4 py-3 text-left">eBay ID</th>
              </tr>
            </thead>
            <tbody>
              {byStatus[tab].map((l) => (
                <ListingMarketRow
                  key={l.id}
                  row={l}
                  sitewideDiscountBps={sitewideDiscountBps}
                  selected={selected.has(l.id)}
                  onToggle={() => toggle(l.id)}
                  onLocalChange={(id, update) =>
                    setListingRows((current) =>
                      current.map((row) => row.id === id ? { ...row, ...update } : row),
                    )
                  }
                  onUpdateDone={(r) =>
                    setNotice(
                      r.error
                        ? { text: r.error, error: true }
                        : { text: "Listing updated", error: false },
                    )
                  }
                />
              ))}
              {byStatus[tab].length === 0 && (
                <tr>
                  <td colSpan={16} className="px-4 py-12 text-center text-slate-500">
                    No {tab.toLowerCase()} listings.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </Card>
      </>
      )}
    </div>
  );
}
