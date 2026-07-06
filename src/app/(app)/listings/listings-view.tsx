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
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";

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
  status: "DRAFT" | "ACTIVE" | "ENDED";
  ebayListingId: string | null;
  publishedAt: string | null;
};

type Tab = "unlisted" | "DRAFT" | "ACTIVE" | "ENDED";

const statusTone = { DRAFT: "amber", ACTIVE: "green", ENDED: "slate" } as const;

function Thumb({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-slate-100 object-cover" />
  ) : (
    <div className="h-10 w-10 shrink-0 rounded-lg bg-slate-100" />
  );
}

function EditCell({
  listing,
  onDone,
}: {
  listing: ListingRow;
  onDone: (r: BulkResult) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState((listing.priceCents / 100).toFixed(2));
  const [qty, setQty] = useState(String(listing.quantity));
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        Edit
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className="w-20 rounded-md border border-slate-300 px-2 py-1 text-xs tabular-nums"
        aria-label="Price (dollars)"
      />
      <input
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        className="w-14 rounded-md border border-slate-300 px-2 py-1 text-xs tabular-nums"
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
            setEditing(false);
          });
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

export function ListingsView({
  unlisted,
  listings,
  activeCount,
  maxActive,
  ebayConnected,
}: {
  unlisted: UnlistedRow[];
  listings: ListingRow[];
  activeCount: number;
  maxActive: number | null;
  ebayConnected: boolean;
}) {
  const [tab, setTab] = useState<Tab>("unlisted");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const byStatus = useMemo(() => {
    const map = { DRAFT: [] as ListingRow[], ACTIVE: [] as ListingRow[], ENDED: [] as ListingRow[] };
    for (const l of listings) map[l.status].push(l);
    return map;
  }, [listings]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "unlisted", label: "Unlisted inventory", count: unlisted.length },
    { id: "DRAFT", label: "Drafts", count: byStatus.DRAFT.length },
    { id: "ACTIVE", label: "Active", count: byStatus.ACTIVE.length },
    { id: "ENDED", label: "Ended", count: byStatus.ENDED.length },
  ];

  const currentIds =
    tab === "unlisted"
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

  function report(result: BulkResult, verb: string) {
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
    setNotice(null);
    startTransition(async () => report(await fn(ids), verb));
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

      {maxActive !== null && (
        <p className="text-xs text-slate-500">
          {activeCount} of {maxActive} active listing slots used on your plan.{" "}
          {activeCount >= maxActive && (
            <Link href="/billing" className="font-medium text-indigo-600">
              Upgrade for more →
            </Link>
          )}
        </p>
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

      <Card className="overflow-x-auto">
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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">
                  <input type="checkbox" checked={allSelected} onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(currentIds))
                  } aria-label="Select all" />
                </th>
                <th className="px-4 py-3">Listing</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">eBay ID</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {byStatus[tab].map((l) => (
                <tr key={l.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggle(l.id)}
                      aria-label={`Select ${l.title}`}
                    />
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Thumb url={l.imageUrl} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900" title={l.title}>
                          {l.title}
                        </p>
                        <p className="text-xs text-slate-500">SKU {l.sku}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCents(l.priceCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{l.quantity}</td>
                  <td className="px-4 py-3">
                    <Badge tone={statusTone[l.status]}>{l.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {l.ebayListingId ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {l.status !== "ENDED" && (
                      <EditCell
                        listing={l}
                        onDone={(r) =>
                          setNotice(
                            r.error
                              ? { text: r.error, error: true }
                              : { text: "Listing updated", error: false },
                          )
                        }
                      />
                    )}
                  </td>
                </tr>
              ))}
              {byStatus[tab].length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No {tab.toLowerCase()} listings.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
