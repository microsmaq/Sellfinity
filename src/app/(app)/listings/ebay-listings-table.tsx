"use client";

import { useState, useTransition } from "react";
import {
  cleanupEbayListings,
  endEbayListing,
  matchEbayListing,
  matchEbayListingsBatch,
  repriceEbayListing,
  researchEbayListingsMarket,
  unmatchEbayListing,
} from "@/lib/actions/ebay-listings";
import {
  classifyListing,
  suggestedListingPriceCents,
} from "@/lib/listings/cleanup";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";

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
};

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
}: {
  rows: EbayRow[];
  fetchError: string | null;
}) {
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);

  function applyTrackResults(results: Awaited<ReturnType<typeof matchEbayListingsBatch>>) {
    setRows((prev) =>
      prev.map((row) => {
        const r = results.find((x) => x.ebayListingId === row.ebayListingId);
        return r && r.ok
          ? { ...row, match: { ...r.match, shippingCostCents: 0 } }
          : row;
      }),
    );
  }

  function matchAll() {
    const unmatchedRows = rows.filter((r) => !r.match);
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

  function cleanUp() {
    // Preview using the same classifier the server applies (shipping cost is
    // 0 for Amazon-sourced items, which all matched imports are).
    const matched = rows.filter((r) => r.match);
    const preview = matched.map((r) => ({
      row: r,
      decision: classifyListing(r.priceCents, r.match!.amazonPriceCents, 0),
    }));
    const toReprice = preview.filter((p) => p.decision.action === "reprice");
    const toEnd = preview.filter((p) => p.decision.action === "end");
    if (toReprice.length === 0 && toEnd.length === 0) {
      setNotice({ text: "Nothing to clean up — every matched listing already meets the 30% margin / $7 profit target.", error: false });
      return;
    }
    if (
      !confirm(
        `Clean up will RAISE prices on ${toReprice.length} listing${toReprice.length === 1 ? "" : "s"} to reach 30% margin or $7 profit (incl. fees + 3% ad rate), and END ${toEnd.length} listing${toEnd.length === 1 ? "" : "s"} with worse than -30% margin.\n\nThis revises your live eBay listings. Continue?`,
      )
    ) {
      return;
    }
    const ids = [...toReprice, ...toEnd].map((p) => p.row.ebayListingId);
    setNotice(null);
    startTransition(async () => {
      let repriced = 0, ended = 0, errors = 0;
      for (let i = 0; i < ids.length; i += 10) {
        const results = await cleanupEbayListings(ids.slice(i, i + 10));
        setRows((prev) =>
          prev.flatMap((row) => {
            const r = results.find((x) => x.ebayListingId === row.ebayListingId);
            if (!r) return [row];
            if (r.action === "ended") return [];
            if (r.action === "repriced" && row.match) {
              return [{
                ...row,
                priceCents: r.newPriceCents!,
                match: { ...row.match, profitCents: r.profitCents!, marginPct: r.marginPct! },
              }];
            }
            return [row];
          }),
        );
        for (const r of results) {
          if (r.action === "repriced") repriced++;
          else if (r.action === "ended") ended++;
          else if (r.action === "error") errors++;
        }
        setBulkProgress(`Cleaning up… ${Math.min(i + 10, ids.length)}/${ids.length} (${repriced} repriced, ${ended} ended)`);
      }
      setBulkProgress(null);
      setNotice({
        text: `Clean-up complete: ${repriced} repriced, ${ended} ended${errors ? `, ${errors} failed` : ""}.`,
        error: false,
      });
    });
  }

  function researchMarket() {
    const missing = rows.filter((row) => !row.market);
    if (missing.length === 0) {
      setNotice({ text: "Market research is already available for every matched listing.", error: false });
      return;
    }
    setNotice(null);
    startTransition(async () => {
      let researched = 0;
      let unavailable = 0;
      let errors = 0;
      for (let i = 0; i < missing.length; i += 10) {
        const batch = missing.slice(i, i + 10).map((row) => ({
          ebayListingId: row.ebayListingId,
          title: row.title,
        }));
        const results = await researchEbayListingsMarket(batch);
        setRows((previous) =>
          previous.map((row) => {
            const result = results.find(
              (item) => item.ebayListingId === row.ebayListingId,
            );
            return result?.market
              ? {
                  ...row,
                  market: result.market,
                  suggestedPriceCents: row.match
                    ? suggestedListingPriceCents(
                        row.match.amazonPriceCents,
                        row.match.shippingCostCents,
                        result.market.averageCompetitorPriceCents,
                      )
                    : null,
                }
              : row;
          }),
        );
        researched += results.filter((result) => result.market).length;
        unavailable += results.filter((result) => !result.market && !result.error).length;
        errors += results.filter((result) => result.error).length;
        setBulkProgress(
          `Researching… ${Math.min(i + 10, missing.length)}/${missing.length} (${researched} found)`,
        );
      }
      setBulkProgress(null);
      setNotice({
        text: `Market research complete: ${researched} updated${unavailable ? `, ${unavailable} without comparable results` : ""}${errors ? `, ${errors} failed` : ""}.`,
        error: errors > 0,
      });
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

  const problems = rows.filter(
    (r) => r.match && (r.match.unavailable || r.match.profitCents <= 0),
  ).length;
  const unmatched = rows.filter((r) => !r.match).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
        <span>{rows.length} active on eBay</span>
        {problems > 0 && <Badge tone="red">{problems} need attention</Badge>}
        <Button size="sm" variant="secondary" disabled={pending} onClick={cleanUp}>
          {bulkProgress?.startsWith("Cleaning") ? bulkProgress : "Clean up prices"}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={researchMarket}>
          {bulkProgress?.startsWith("Researching") ? bulkProgress : "Research market data"}
        </Button>
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

      {fetchError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Couldn&apos;t load your eBay listings: {fetchError}
        </p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Listing</th>
              <th className="px-4 py-3 text-right">My price</th>
              <th className="px-4 py-3 text-right">Amazon price</th>
              <th className="px-4 py-3 text-right">Profit / unit</th>
              <th className="px-4 py-3 text-right" title="Average estimated sales per researched competitor over 30 days">
                Est. demand
              </th>
              <th className="px-4 py-3 text-right" title="Comparable listings in Sellfinity's eBay research database">
                Competition
              </th>
              <th className="px-4 py-3 text-right">Avg. comp price</th>
              <th className="px-4 py-3 text-right" title="Profitable floor using product cost, shipping, eBay fees, and 3% ad rate">
                Suggested price
              </th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const problem =
                r.match && (r.match.unavailable || r.match.profitCents <= 0);
              return (
                <tr
                  key={r.ebayListingId}
                  className={cx(
                    "border-b border-slate-100 last:border-0",
                    problem && "bg-red-50/40",
                  )}
                >
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
                    {r.market
                      ? formatCents(r.market.averageCompetitorPriceCents)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-indigo-700">
                    {r.suggestedPriceCents !== null
                      ? formatCents(r.suggestedPriceCents)
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {!r.match ? (
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
                    {!r.match ? (
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
                    ) : (
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
                                    ? { ...x, match: null }
                                    : x,
                                ),
                              ),
                            "Unmatched.",
                          )
                        }
                      >
                        Unmatch
                      </Button>
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
            {rows.length === 0 && !fetchError && (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-slate-500">
                  No active listings found on your eBay account.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
