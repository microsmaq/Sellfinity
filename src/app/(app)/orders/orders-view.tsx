"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";

export type FulfillmentLineRow = {
  lineItemId: string;
  ebayListingId: string;
  ebayUrl: string;
  title: string;
  quantity: number;
  salePriceCents: number;
  shippingChargedCents: number;
  fulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS";
  shipByDate: string | null;
  variation: string | null;
  source: {
    title: string;
    sku: string;
    url: string;
    imageUrl: string | null;
    unitCostCents: number;
    shippingCostCents: number;
    stock: number;
  } | null;
  estimatedProfitCents: number | null;
};

export type FulfillmentOrderRow = {
  orderId: string;
  createdAt: string;
  buyerUsername: string;
  paymentStatus: string;
  fulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS";
  lines: FulfillmentLineRow[];
};

export type PurchaseHistoryRow = { id: string; ebayOrderId: string; ebayTitle: string; amazonOrderId: string; amazonTitle: string; amazonUrl: string | null; purchasedAt: string | null; sourcingStatus: string; trackingNumber: string | null; trackingSyncedAt: string | null; trackingSyncError: string | null; revenueCents: number; ebayFeeCents: number; actualAmazonCostCents: number | null; estimatedAmazonCostCents: number; confidence: number | null };
export type AmazonPurchaseRow = { id: string; amazonOrderId: string; purchasedAt: string | null; status: string; subtotalCents: number | null; shippingCents: number; taxCents: number; discountCents: number; totalCents: number | null; trackingNumber: string | null; carrier: string | null; items: { id: string; asin: string | null; title: string; quantity: number; unitPriceCents: number | null; amazonUrl: string | null; matched: boolean }[] };

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function shipByLabel(value: string | null): { text: string; urgent: boolean } {
  if (!value) return { text: "Not provided", urgent: false };
  const date = new Date(value);
  const urgent = date.getTime() < Date.now() + 24 * 60 * 60 * 1000;
  return {
    text: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date),
    urgent,
  };
}

export function OrdersView({
  orders,
  fetchError,
  purchaseHistory,
  amazonPurchases,
}: {
  orders: FulfillmentOrderRow[];
  fetchError: string | null;
  purchaseHistory: PurchaseHistoryRow[];
  amazonPurchases: AmazonPurchaseRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"ALL" | "NOT_STARTED" | "IN_PROGRESS">("ALL");
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return orders.filter((order) => {
      if (status !== "ALL" && order.fulfillmentStatus !== status) return false;
      if (!needle) return true;
      return [order.orderId, order.buyerUsername, ...order.lines.flatMap((line) => [
        line.title,
        line.ebayListingId,
        line.source?.title ?? "",
        line.source?.sku ?? "",
      ])].some((value) => value.toLowerCase().includes(needle));
    });
  }, [orders, query, status]);

  const lineCount = orders.reduce((sum, order) => sum + order.lines.length, 0);
  const unitCount = orders.reduce(
    (sum, order) => sum + order.lines.reduce((lineSum, line) => lineSum + line.quantity, 0),
    0,
  );
  const missingSources = orders.reduce(
    (sum, order) => sum + order.lines.filter((line) => !line.source).length,
    0,
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Orders to fulfill" value={orders.length.toLocaleString()} />
        <StatCard label="Line items" value={lineCount.toLocaleString()} />
        <StatCard label="Units to source" value={unitCount.toLocaleString()} />
        <StatCard label="Missing Amazon sources" value={missingSources.toLocaleString()} tone={missingSources ? "negative" : "positive"} />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[260px] flex-1">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search order, buyer, eBay item, ASIN, or Amazon source…" />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="ALL">All fulfillment statuses</option>
            <option value="NOT_STARTED">Not started</option>
            <option value="IN_PROGRESS">In progress</option>
          </select>
          <Button variant="secondary" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
            {pending ? "Refreshing…" : "↻ Refresh from eBay"}
          </Button>
        </div>
      </Card>

      {fetchError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn&apos;t retrieve orders from eBay: {fetchError}
        </p>
      )}

      {filtered.map((order) => {
        const orderRevenue = order.lines.reduce(
          (sum, line) => sum + line.salePriceCents * line.quantity + line.shippingChargedCents,
          0,
        );
        return (
          <Card key={order.orderId} className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold text-slate-900">Order {order.orderId}</h2>
                  <Badge tone={order.fulfillmentStatus === "NOT_STARTED" ? "amber" : "indigo"}>
                    {order.fulfillmentStatus === "NOT_STARTED" ? "Not started" : "In progress"}
                  </Badge>
                  <Badge tone="green">{order.paymentStatus.replaceAll("_", " ")}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {displayDate(order.createdAt)} · Buyer {order.buyerUsername}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-500">eBay order revenue</p>
                <p className="text-lg font-semibold tabular-nums text-slate-900">{formatCents(orderRevenue)}</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1320px] text-sm">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3 text-left">eBay item ordered</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">eBay sale</th>
                    <th className="px-4 py-3 text-left">Equivalent Amazon source</th>
                    <th className="px-4 py-3 text-right">Amazon landed</th>
                    <th className="px-4 py-3 text-right">Est. profit</th>
                    <th className="px-4 py-3 text-left">Ship by</th>
                    <th className="px-4 py-3 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => {
                    const shipBy = shipByLabel(line.shipByDate);
                    return (
                      <tr key={line.lineItemId} className="border-t border-slate-100 align-top hover:bg-slate-50/70">
                        <td className="min-w-[300px] px-5 py-4">
                          <a href={line.ebayUrl} target="_blank" rel="noreferrer" className="line-clamp-2 font-semibold text-slate-900 hover:text-indigo-600">{line.title}</a>
                          <p className="mt-1 text-xs text-slate-500">eBay #{line.ebayListingId}</p>
                          {line.variation && <p className="mt-1 text-xs font-medium text-violet-700">{line.variation}</p>}
                        </td>
                        <td className="px-4 py-4 text-right font-semibold tabular-nums">{line.quantity}</td>
                        <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums">
                          <span className="font-semibold">{formatCents(line.salePriceCents * line.quantity + line.shippingChargedCents)}</span>
                          <p className="mt-0.5 text-[11px] text-slate-500">{formatCents(line.salePriceCents)} each{line.shippingChargedCents ? ` · ${formatCents(line.shippingChargedCents)} shipping` : ""}</p>
                        </td>
                        <td className="min-w-[330px] px-4 py-4">
                          {line.source ? (
                            <div className="flex gap-3">
                              {line.source.imageUrl ? (
                                // External Amazon images use dynamic hosts that are not safe to enumerate for next/image.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={line.source.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-slate-200 bg-white object-contain" />
                              ) : <div className="h-14 w-14 shrink-0 rounded-lg bg-slate-100" />}
                              <div className="min-w-0">
                                <a href={line.source.url} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium text-indigo-700 hover:underline">{line.source.title}</a>
                                <p className="mt-1 text-xs text-slate-500">{line.source.sku} · {line.source.stock} available</p>
                              </div>
                            </div>
                          ) : <Badge tone="red">No tracked Amazon source</Badge>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-4 text-right tabular-nums">
                          {line.source ? <><span className="font-semibold">{formatCents((line.source.unitCostCents + line.source.shippingCostCents) * line.quantity)}</span><p className="mt-0.5 text-[11px] text-slate-500">{formatCents(line.source.unitCostCents + line.source.shippingCostCents)} each</p></> : "—"}
                        </td>
                        <td className={cx("whitespace-nowrap px-4 py-4 text-right font-semibold tabular-nums", line.estimatedProfitCents === null ? "text-slate-400" : line.estimatedProfitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{line.estimatedProfitCents === null ? "—" : formatCents(line.estimatedProfitCents)}</td>
                        <td className={cx("whitespace-nowrap px-4 py-4", shipBy.urgent ? "font-semibold text-red-600" : "text-slate-700")}>
                          {shipBy.text}
                          <p className="mt-0.5 text-[11px] font-normal text-slate-500">{line.fulfillmentStatus === "NOT_STARTED" ? "Awaiting shipment" : "Fulfillment started"}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-4">
                          {line.source ? <a href={line.source.url} target="_blank" rel="noreferrer" className="inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Buy on Amazon ↗</a> : <a href="/listings" className="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Find source</a>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      {!fetchError && filtered.length === 0 && (
        <Card className="px-6 py-16 text-center">
          <p className="font-semibold text-slate-900">No orders currently need fulfillment</p>
          <p className="mt-1 text-sm text-slate-500">New paid eBay orders will appear here until their fulfillment is completed.</p>
        </Card>
      )}

      <div className="pt-4">
        <div className="mb-3 flex items-end justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Detected Amazon purchases</h2><p className="text-xs text-slate-500">Order totals and fulfillment updates extracted from authorized Amazon emails.</p></div><Badge tone="slate">{amazonPurchases.length} orders</Badge></div>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-4 py-3">Amazon order</th><th className="px-4 py-3">Items</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Subtotal</th><th className="px-4 py-3 text-right">Shipping</th><th className="px-4 py-3 text-right">Tax</th><th className="px-4 py-3 text-right">Discount</th><th className="px-4 py-3 text-right">Total</th></tr></thead>
          <tbody>{amazonPurchases.map((purchase) => <tr key={purchase.id} className="border-b border-slate-100 align-top last:border-0"><td className="whitespace-nowrap px-4 py-3"><p className="font-medium text-slate-900">#{purchase.amazonOrderId}</p><p className="text-xs text-slate-500">{purchase.purchasedAt ? displayDate(purchase.purchasedAt) : "Date unavailable"}</p>{purchase.trackingNumber && <p className="text-xs text-slate-500">{purchase.carrier ? `${purchase.carrier} · ` : ""}{purchase.trackingNumber}</p>}</td><td className="max-w-[360px] px-4 py-3">{purchase.items.length ? purchase.items.map((item) => <div key={item.id} className="mb-2 last:mb-0">{item.amazonUrl ? <a href={item.amazonUrl} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium text-indigo-700 hover:underline">{item.title}</a> : <p className="line-clamp-2 font-medium">{item.title}</p>}<p className="text-xs text-slate-500">{item.asin || "ASIN unavailable"} · Qty {item.quantity} · {item.unitPriceCents === null ? "Price in order total" : formatCents(item.unitPriceCents)} · <span className={item.matched ? "text-emerald-600" : "text-amber-600"}>{item.matched ? "matched" : "needs review"}</span></p></div>) : <span className="text-amber-600">Item details unavailable in this email</span>}</td><td className="px-4 py-3"><Badge tone={purchase.status === "DELIVERED" ? "green" : purchase.status === "CANCELLED" ? "red" : "indigo"}>{purchase.status.toLowerCase()}</Badge></td><td className="px-4 py-3 text-right tabular-nums">{purchase.subtotalCents === null ? "—" : formatCents(purchase.subtotalCents)}</td><td className="px-4 py-3 text-right tabular-nums">{formatCents(purchase.shippingCents)}</td><td className="px-4 py-3 text-right tabular-nums">{formatCents(purchase.taxCents)}</td><td className="px-4 py-3 text-right tabular-nums text-emerald-700">{purchase.discountCents ? `−${formatCents(purchase.discountCents)}` : "$0.00"}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{purchase.totalCents === null ? "—" : formatCents(purchase.totalCents)}</td></tr>)}</tbody></table>
          {amazonPurchases.length === 0 && <p className="px-6 py-12 text-center text-sm text-slate-500">No Amazon purchases detected yet. Connect Gmail in Settings, then check purchases.</p>}
        </Card>
      </div>

      <div className="pt-4">
        <div className="mb-3 flex items-end justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Amazon fulfillment history</h2><p className="text-xs text-slate-500">Actual purchase costs matched to eBay sales. Tax, Amazon shipping, and discounts are included.</p></div><Badge tone="indigo">{purchaseHistory.length} reconciled</Badge></div>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-4 py-3">Purchased</th><th className="px-4 py-3">eBay sale</th><th className="px-4 py-3">Amazon purchase</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3 text-right">eBay fee</th><th className="px-4 py-3 text-right">Amazon cost</th><th className="px-4 py-3 text-right">Profit</th></tr></thead>
          <tbody>{purchaseHistory.map((row) => { const cost = row.actualAmazonCostCents ?? row.estimatedAmazonCostCents; const profit = row.revenueCents - row.ebayFeeCents - cost; return <tr key={row.id} className="border-b border-slate-100 align-top last:border-0"><td className="whitespace-nowrap px-4 py-3">{row.purchasedAt ? displayDate(row.purchasedAt) : "—"}</td><td className="max-w-[280px] px-4 py-3"><p className="line-clamp-2 font-medium text-slate-900">{row.ebayTitle}</p><p className="text-xs text-slate-500">{row.ebayOrderId}</p></td><td className="max-w-[300px] px-4 py-3">{row.amazonUrl ? <a href={row.amazonUrl} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium text-indigo-700 hover:underline">{row.amazonTitle}</a> : <p className="line-clamp-2">{row.amazonTitle}</p>}<p className="text-xs text-slate-500">Amazon #{row.amazonOrderId} · {row.confidence ?? 0}% match</p>{row.trackingNumber && <p className="text-xs text-slate-500">Tracking {row.trackingNumber}</p>}{row.trackingSyncedAt && <p className="text-xs font-medium text-emerald-700">Tracking sent to eBay</p>}{row.trackingSyncError && <p className="line-clamp-2 text-xs text-red-600" title={row.trackingSyncError}>eBay update failed: {row.trackingSyncError}</p>}</td><td className="px-4 py-3"><Badge tone={row.sourcingStatus === "DELIVERED" ? "green" : "indigo"}>{row.sourcingStatus.toLowerCase()}</Badge></td><td className="px-4 py-3 text-right tabular-nums">{formatCents(row.revenueCents)}</td><td className="px-4 py-3 text-right tabular-nums text-slate-500">{formatCents(row.ebayFeeCents)}</td><td className="px-4 py-3 text-right font-medium tabular-nums">{formatCents(cost)}<p className="text-[10px] font-normal text-slate-400">{row.actualAmazonCostCents === null ? "estimated" : "verified"}</p></td><td className={cx("px-4 py-3 text-right font-semibold tabular-nums", profit >= 0 ? "text-emerald-700" : "text-red-600")}>{formatCents(profit)}</td></tr>; })}</tbody></table>
          {purchaseHistory.length === 0 && <p className="px-6 py-12 text-center text-sm text-slate-500">Connect Gmail in Settings and check purchases to build verified fulfillment history.</p>}
        </Card>
      </div>
    </div>
  );
}
