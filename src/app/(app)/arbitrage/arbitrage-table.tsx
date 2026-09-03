"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  approveArbitrageMatch,
  exportArbitrageExcel,
  hideArbitrageItem,
} from "@/lib/actions/arbitrage";
import { createArbitrageMirrorBatch } from "@/lib/actions/mirror-batches";
import type {
  ArbitragePage,
  ArbitragePageParams,
} from "@/lib/arbitrage/store";
import type { OpportunityRow } from "@/lib/arbitrage/scanner";
import { assessPriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";
import { downloadBase64File } from "@/lib/download";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";

type SortKey = ArbitragePageParams["sortKey"];

function confidenceTone(value: number): "green" | "amber" | "red" {
  if (value >= 95) return "green";
  if (value >= 75) return "amber";
  return "red";
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
  sortKey: SortKey;
  filters: ArbitragePageParams;
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
        sticky === "left" && "left-12 z-40",
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

function eligible(row: OpportunityRow) {
  return !row.mirrored && ["MATCH", "LIKELY"].includes(row.matchVerdict);
}

function FinderRow({
  row,
  selected,
  busy,
  onSelect,
  onPublish,
  onHide,
  onApprove,
  sitewideDiscountBps,
}: {
  row: OpportunityRow;
  selected: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onPublish: () => void;
  onHide: () => void;
  onApprove: () => void;
  sitewideDiscountBps: number;
}) {
  const publishable = eligible(row);
  const competitiveness = assessPriceCompetitiveness(
    row.suggestedListingPriceCents,
    row.ebayPriceCents,
    row.avgCompPriceCents,
    row.ebayRecommendedPriceCents,
    null,
    sitewideDiscountBps,
  );
  return (
    <tr className="group border-t border-slate-100 align-top hover:bg-slate-50/70">
      <td className="sticky left-0 z-10 w-12 bg-white px-3 py-5 group-hover:bg-slate-50">
        <input
          type="checkbox"
          checked={selected}
          disabled={!publishable}
          onChange={(event) => onSelect(event.target.checked)}
          aria-label={`Select ${row.amazonTitle}`}
          className="h-4 w-4 rounded border-slate-300 text-indigo-600"
        />
      </td>
      <td className="sticky left-12 z-10 min-w-[390px] bg-white px-5 py-4 group-hover:bg-slate-50">
        <div className="flex gap-3">
          {row.amazonImageUrl || row.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.amazonImageUrl || row.imageUrl}
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
            <p className="mt-1 text-xs text-slate-500">{row.asin}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {row.isAmazonBestSeller && <Badge tone="indigo">Amazon bestseller</Badge>}
              {row.mirrored && <Badge tone="green">Listed by you</Badge>}
            </div>
          </div>
        </div>
      </td>
      <td className="min-w-[170px] px-4 py-4 text-sm text-slate-700">{row.category}</td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums">
        {formatCents(row.amazonPriceCents + row.amazonShippingCents)}
        <p className="mt-0.5 text-[11px] font-normal text-slate-500">
          {formatCents(row.amazonPriceCents)}
          {row.amazonShippingCents > 0
            ? ` + ${formatCents(row.amazonShippingCents)} shipping`
            : " · free shipping"}
        </p>
      </td>
      <td className="min-w-[330px] px-4 py-4">
        <div className="flex gap-3">
          {row.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 bg-white object-contain" />
          ) : <div className="h-16 w-16 shrink-0 rounded-lg bg-slate-100" />}
          <div className="min-w-0">
            <a href={row.ebayUrl} target="_blank" rel="noreferrer" className="line-clamp-2 text-sm font-medium text-slate-800 hover:text-indigo-600">{row.title}</a>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge tone={confidenceTone(row.matchConfidence)}>{row.matchVerdict} {row.matchConfidence}%</Badge>
              {row.matchMethod === "MANUAL" && <Badge tone="green">Verified by you</Badge>}
            </div>
            {row.matchReason && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{row.matchReason}</p>}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-medium tabular-nums">
        {formatCents(row.ebayPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.avgCompPriceCents === null ? "—" : formatCents(row.avgCompPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        {row.ebayRecommendedPriceCents === null
          ? <span className="text-slate-400">—</span>
          : formatCents(row.ebayRecommendedPriceCents)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold text-indigo-700">
        {formatCents(row.suggestedListingPriceCents)}
      </td>
      <td className="min-w-[250px] px-4 py-4">
        <Badge tone={competitiveness.tone}>{competitiveness.label}</Badge>
        <p className="mt-1.5 text-xs leading-4 text-slate-500">
          {competitiveness.summary}
        </p>
      </td>
      <td className="px-4 py-4 text-right"><CellValue value={row.ebaySales30d} /></td>
      <td className="px-4 py-4 text-right"><CellValue value={row.competitorCount} /></td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        <span className={row.profitCents > 0 ? "font-semibold text-emerald-700" : "text-red-600"}>
          {formatCents(row.profitCents)}
        </span>
      </td>
      <td className="px-4 py-4 text-right">
        <span className={row.marginPct >= 15 ? "font-semibold text-emerald-700" : "text-amber-700"}>
          {row.marginPct}%
        </span>
      </td>
      <td className="px-4 py-4 text-right font-semibold tabular-nums">{row.usersListed}</td>
      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">
        {row.lastResearchedAt
          ? new Date(row.lastResearchedAt).toLocaleDateString()
          : "Not researched"}
      </td>
      <td className="sticky right-0 min-w-[170px] bg-white px-4 py-4 group-hover:bg-slate-50">
        <div className="flex flex-col gap-1.5">
          {row.storeEbayUrl ? (
            <a
              href={row.storeEbayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex justify-center rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              View your listing ↗
            </a>
          ) : publishable ? (
            <Button size="sm" disabled={busy} onClick={onPublish}>
              {busy ? "Starting…" : "Publish to eBay"}
            </Button>
          ) : row.matchVerdict === "REVIEW" ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onApprove}>{busy ? "Approving…" : "Approve match"}</Button>
          ) : (
            <span className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-center text-xs font-medium text-amber-700">Review match first</span>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onHide}>
            Hide from my finder
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function ArbitrageTable({
  data,
  filters,
  sitewideDiscountBps,
}: {
  data: ArbitragePage;
  filters: ArbitragePageParams;
  sitewideDiscountBps: number;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function urlFor(
    overrides: Partial<Record<
      "page" | "q" | "category" | "match" | "minMargin" |
      "minConfidence" | "qualified" | "unlisted" | "sort" | "dir" | "pageSize",
      string | number
    >> = {},
  ) {
    const params = new URLSearchParams({
      page: "1",
      q: filters.query,
      category: filters.category,
      match: filters.matchVerdict ?? "ALL",
      minMargin: String(filters.minMarginPct),
      minConfidence: String(filters.minConfidence ?? 0),
      qualified: filters.qualifiedOnly ? "1" : "0",
      unlisted: filters.unlistedOnly ? "1" : "0",
      sort: filters.sortKey,
      dir: filters.sortDesc ? "desc" : "asc",
      pageSize: String(filters.pageSize ?? 50),
    });
    for (const [key, value] of Object.entries(overrides)) params.set(key, String(value));
    return `/arbitrage?${params.toString()}`;
  }

  function sortHref(sortKey: SortKey) {
    return urlFor({
      sort: sortKey,
      dir: filters.sortKey === sortKey && filters.sortDesc ? "asc" : "desc",
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(
      checked
        ? new Set(data.rows.filter(eligible).map((row) => row.ebayItemId))
        : new Set(),
    );
  }

  function publish(ids: string[]) {
    setNotice(null);
    setBusyId(ids.length === 1 ? ids[0] : "bulk");
    startTransition(async () => {
      const result = await createArbitrageMirrorBatch(ids);
      setBusyId(null);
      if (result.error || !result.batchId) {
        setNotice({ text: result.error ?? "Could not start the publishing batch.", error: true });
        return;
      }
      router.push(`/mirror/batches/${result.batchId}`);
    });
  }

  function hide(row: OpportunityRow) {
    setBusyId(row.ebayItemId);
    setNotice(null);
    startTransition(async () => {
      await hideArbitrageItem(row.ebayItemId);
      setSelected((current) => {
        const next = new Set(current);
        next.delete(row.ebayItemId);
        return next;
      });
      setBusyId(null);
      router.refresh();
    });
  }

  function approve(row: OpportunityRow) {
    setBusyId(row.ebayItemId);
    setNotice(null);
    startTransition(async () => {
      const result = await approveArbitrageMatch(row.ebayItemId);
      setBusyId(null);
      setNotice({ text: result.message, error: !result.ok });
      if (result.ok) router.refresh();
    });
  }

  function exportExcel() {
    setBusyId("export");
    startTransition(async () => {
      const file = await exportArbitrageExcel(filters);
      downloadBase64File(
        file.filename,
        file.base64,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      setBusyId(null);
      setNotice({
        text: `Exported ${data.total.toLocaleString()} matching opportunities.`,
        error: false,
      });
    });
  }

  const eligibleRows = data.rows.filter(eligible);
  const allSelected =
    eligibleRows.length > 0 &&
    eligibleRows.every((row) => selected.has(row.ebayItemId));

  return (
    <div className={cx(
      "space-y-5",
      !expanded && "w-full md:relative md:left-1/2 md:w-[calc(100vw-17rem)] md:-translate-x-1/2",
    )}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Published opportunities" value={data.counts.published.toLocaleString()} />
        <StatCard label="High-confidence & profitable" value={data.counts.qualified.toLocaleString()} tone="positive" />
        <StatCard label="Your active products" value={data.counts.listedByUser.toLocaleString()} />
        <StatCard label="Hidden by you" value={data.counts.hiddenByUser.toLocaleString()} />
      </div>

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
      <Card className={cx(
        "min-w-0 overflow-hidden",
        expanded && "fixed inset-3 z-50 flex flex-col rounded-2xl border-slate-300 shadow-2xl",
      )}>
        <div className="border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">Published product intelligence</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Curated by Sellfinity admins. Profit and margin include Amazon shipping,
                eBay fees, and a 3% advertising allowance.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">{data.total.toLocaleString()} results</span>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={exportExcel}
              >
                {busyId === "export" ? "Exporting…" : "Export Excel"}
              </Button>
              <Button
                type="button"
                disabled={pending || selected.size === 0}
                onClick={() => publish([...selected])}
              >
                Publish selected ({selected.size})
              </Button>
              <Button type="button" variant="secondary" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "↙ Exit full screen" : "↗ Expand table"}
              </Button>
            </div>
          </div>

          <form action="/arbitrage" method="get" className="mt-4 space-y-3">
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
              >
                <option value="all">All categories</option>
                {data.categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
              <Button type="submit">Search & filter</Button>
              <Link href="/arbitrage" className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100">
                Clear
              </Link>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
              <select name="match" defaultValue={filters.matchVerdict ?? "ALL"} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="ALL">Any match status</option>
                <option value="MATCH">Exact match</option>
                <option value="LIKELY">Likely match</option>
                <option value="REVIEW">Needs your review</option>
              </select>
              <select name="minMargin" defaultValue={String(filters.minMarginPct)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="0">Any margin</option>
                <option value="10">Margin ≥ 10%</option>
                <option value="15">Margin ≥ 15%</option>
                <option value="20">Margin ≥ 20%</option>
                <option value="30">Margin ≥ 30%</option>
              </select>
              <select name="minConfidence" defaultValue={String(filters.minConfidence ?? 0)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="0">Any confidence</option>
                <option value="70">Confidence ≥ 70%</option>
                <option value="85">Confidence ≥ 85%</option>
                <option value="95">Confidence ≥ 95%</option>
              </select>
              <select name="pageSize" defaultValue={String(filters.pageSize ?? 50)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="25">25 per page</option>
                <option value="50">50 per page</option>
                <option value="100">100 per page</option>
                <option value="250">250 per page</option>
                <option value="500">500 per page</option>
                <option value="1000">1,000 per page</option>
              </select>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">
                <input type="checkbox" name="qualified" value="1" defaultChecked={filters.qualifiedOnly} className="h-4 w-4 rounded border-emerald-400 text-emerald-600" />
                Qualified only
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-900">
                <input type="checkbox" name="unlisted" value="1" defaultChecked={filters.unlistedOnly} className="h-4 w-4 rounded border-indigo-400 text-indigo-600" />
                Unlisted by me only
              </label>
            </div>
          </form>
        </div>

        <div className={cx("overflow-auto", expanded ? "min-h-0 flex-1" : "max-h-[72vh]")}>
          <table className="w-full min-w-[2850px] text-sm">
            <thead className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="sticky left-0 top-0 z-50 w-12 bg-slate-50 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={eligibleRows.length === 0}
                    onChange={(event) => toggleAll(event.target.checked)}
                    aria-label="Select all publishable products on this page"
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  />
                </th>
                <SortHeader label="Amazon item" sortKey="amazonTitle" filters={filters} href={sortHref("amazonTitle")} align="left" sticky="left" />
                <SortHeader label="Category" sortKey="category" filters={filters} href={sortHref("category")} align="left" />
                <SortHeader label="Amazon landed cost" sortKey="amazonPrice" filters={filters} href={sortHref("amazonPrice")} />
                <SortHeader label="Equivalent eBay item" sortKey="matchConfidence" filters={filters} href={sortHref("matchConfidence")} align="left" />
                <SortHeader label="eBay price" sortKey="ebayPrice" filters={filters} href={sortHref("ebayPrice")} />
                <SortHeader label="Competitor avg" sortKey="avgCompPrice" filters={filters} href={sortHref("avgCompPrice")} />
                <SortHeader label="eBay recommended" sortKey="recommendedPrice" filters={filters} href={sortHref("recommendedPrice")} />
                <SortHeader label="Suggested price" sortKey="suggestedPrice" filters={filters} href={sortHref("suggestedPrice")} />
                <th className="sticky top-0 z-30 bg-slate-50 px-4 py-3 text-left">Price assessment</th>
                <SortHeader label="Sales / month" sortKey="sales" filters={filters} href={sortHref("sales")} />
                <SortHeader label="Competition" sortKey="competition" filters={filters} href={sortHref("competition")} />
                <SortHeader label="Profit after ads" sortKey="profit" filters={filters} href={sortHref("profit")} />
                <SortHeader label="Margin after ads" sortKey="margin" filters={filters} href={sortHref("margin")} />
                <SortHeader label="Users listed" sortKey="usersListed" filters={filters} href={sortHref("usersListed")} />
                <SortHeader label="Researched" sortKey="researched" filters={filters} href={sortHref("researched")} align="left" />
                <th className="sticky right-0 top-0 z-40 bg-slate-50 px-4 py-3 text-left">Publish</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <FinderRow
                  key={row.ebayItemId}
                  row={row}
                  selected={selected.has(row.ebayItemId)}
                  busy={pending && (busyId === row.ebayItemId || busyId === "bulk")}
                  onSelect={(checked) => setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(row.ebayItemId);
                    else next.delete(row.ebayItemId);
                    return next;
                  })}
                  onPublish={() => publish([row.ebayItemId])}
                  onHide={() => hide(row)}
                  onApprove={() => approve(row)}
                  sitewideDiscountBps={sitewideDiscountBps}
                />
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && (
            <div className="px-6 py-16 text-center text-sm text-slate-500">
              No admin-published opportunities match these search filters.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-white px-5 py-3 text-sm">
          <span className="text-slate-500">
            Page {data.page} of {data.pageCount} · {data.total.toLocaleString()} matching products
          </span>
          <div className="flex gap-2">
            {data.page > 1 ? (
              <Link href={urlFor({ page: data.page - 1 })} className="rounded-lg border px-3 py-1.5 hover:bg-slate-50">Previous</Link>
            ) : <span />}
            {data.page < data.pageCount && (
              <Link href={urlFor({ page: data.page + 1 })} className="rounded-lg border px-3 py-1.5 hover:bg-slate-50">Next</Link>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
