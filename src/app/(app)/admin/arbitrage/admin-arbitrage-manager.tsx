"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import {
  adminAddAmazonItem,
  adminArchiveItem,
  adminPublishItem,
  adminResearchItem,
  adminScanBestSellers,
} from "@/lib/actions/admin-arbitrage";
import type {
  AdminCatalogPage,
  AdminCatalogRow,
  AdminCatalogStatus,
} from "@/lib/arbitrage/admin-catalog";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";

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

function CatalogRow({
  row,
  busy,
  run,
}: {
  row: AdminCatalogRow;
  busy: boolean;
  run: (kind: "research" | "publish" | "archive", id: string) => void;
}) {
  return (
    <tr className="border-t border-slate-100 align-top hover:bg-slate-50/70">
      <td className="sticky left-0 z-10 min-w-[310px] bg-white px-4 py-4 group-hover:bg-slate-50">
        <div className="flex gap-3">
          {row.amazonImageUrl ?? row.ebayImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.amazonImageUrl ?? row.ebayImageUrl ?? ""}
              alt=""
              className="h-14 w-14 shrink-0 rounded-lg border border-slate-200 object-contain"
            />
          ) : (
            <div className="h-14 w-14 shrink-0 rounded-lg bg-slate-100" />
          )}
          <div className="min-w-0">
            <a
              href={row.amazonUrl}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-2 text-sm font-semibold text-slate-900 hover:text-indigo-600"
            >
              {row.amazonTitle}
            </a>
            <p className="mt-1 text-xs text-slate-500">
              {row.asin} · {row.category}
            </p>
            <div className="mt-1 flex gap-1.5">
              <Badge tone={statusTone(row.status)}>{row.status.replace("_", " ")}</Badge>
              {row.isAmazonBestSeller && <Badge tone="indigo">Amazon bestseller</Badge>}
            </div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums">
        {formatCents(row.amazonPriceCents)}
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
              <span className="text-xs text-slate-500">
                {row.ebayPriceCents ? formatCents(row.ebayPriceCents) : "No price"}
              </span>
            </div>
            {row.matchReason && (
              <p className="mt-1 line-clamp-2 text-xs text-slate-500">{row.matchReason}</p>
            )}
          </>
        ) : (
          <span className="text-sm text-slate-400">No equivalent found</span>
        )}
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
      <td className="sticky right-0 min-w-[150px] bg-white px-4 py-4">
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
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
  query,
  status,
}: {
  data: AdminCatalogPage;
  query: string;
  status: AdminCatalogStatus;
}) {
  const router = useRouter();
  const [amazonInput, setAmazonInput] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function finish(result: { ok: boolean; message: string }) {
    setNotice({ text: result.message, error: !result.ok });
    if (result.ok) router.refresh();
  }

  function addAmazon(event: FormEvent) {
    event.preventDefault();
    if (!amazonInput.trim()) return;
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
    setOperation("Scanning bestseller sources and verifying profitable matches");
    setNotice(null);
    startTransition(async () => {
      finish(await adminScanBestSellers(50));
      setOperation(null);
    });
  }

  function run(kind: "research" | "publish" | "archive", id: string) {
    setBusyId(id);
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

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const q = String(form.get("q") ?? "").trim();
    router.push(`/admin/arbitrage?status=${status}&q=${encodeURIComponent(q)}`);
  }

  const pageHref = (page: number) =>
    `/admin/arbitrage?page=${page}&status=${status}&q=${encodeURIComponent(query)}`;

  return (
    <div className="space-y-5">
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
            <form onSubmit={addAmazon} className="mt-4 flex max-w-2xl gap-2">
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
          <div className="flex items-center">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={scan}
              className="border-white/30 bg-white/10 text-white hover:bg-white/20"
            >
              ✦ Add 50 bestsellers
            </Button>
          </div>
        </div>
      </Card>

      {operation && (
        <PremiumProgress
          title={operation}
          subtitle="Completed data is saved as each provider finishes."
          percentage={pending ? 38 : 100}
          status={pending ? "running" : "complete"}
          stats={[
            { label: "Amazon source", value: "checking", tone: "info" },
            { label: "eBay market", value: "matching", tone: "info" },
            { label: "Profit model", value: "calculating", tone: "success" },
          ]}
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

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {statusOptions.map((option) => (
              <Link
                key={option.value}
                href={`/admin/arbitrage?status=${option.value}&q=${encodeURIComponent(query)}`}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold",
                  status === option.value
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {option.label}
              </Link>
            ))}
          </div>
          <form onSubmit={search} className="flex w-full max-w-sm gap-2">
            <Input name="q" defaultValue={query} placeholder="Search Amazon title or ASIN…" />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[2050px] w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="sticky left-0 z-20 bg-slate-50 px-4 py-3 text-left">Amazon item</th>
                <th className="px-4 py-3 text-right">Amazon price</th>
                <th className="px-4 py-3 text-left">Equivalent eBay item</th>
                <th className="px-4 py-3 text-right">Competitor avg</th>
                <th className="px-4 py-3 text-right">eBay recommended</th>
                <th className="px-4 py-3 text-right">Suggested price</th>
                <th className="px-4 py-3 text-right">Sales / month</th>
                <th className="px-4 py-3 text-right">Competition</th>
                <th className="px-4 py-3 text-right">Profit</th>
                <th className="px-4 py-3 text-right">Margin</th>
                <th className="px-4 py-3 text-right">Users listed</th>
                <th className="px-4 py-3 text-left">Researched</th>
                <th className="sticky right-0 z-20 bg-slate-50 px-4 py-3 text-left">Manage</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <CatalogRow
                  key={row.id}
                  row={row}
                  busy={pending && busyId === row.id}
                  run={run}
                />
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && (
            <div className="px-6 py-16 text-center text-sm text-slate-500">
              No catalog products match this view.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
          <span className="text-slate-500">
            Page {data.page} of {data.pageCount} · {data.total.toLocaleString()} products
          </span>
          <div className="flex gap-2">
            {data.page > 1 ? (
              <Link href={pageHref(data.page - 1)} className="rounded-lg border px-3 py-1.5 hover:bg-slate-50">
                Previous
              </Link>
            ) : <span />}
            {data.page < data.pageCount && (
              <Link href={pageHref(data.page + 1)} className="rounded-lg border px-3 py-1.5 hover:bg-slate-50">
                Next
              </Link>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
