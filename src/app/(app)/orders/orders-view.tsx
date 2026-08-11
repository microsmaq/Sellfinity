"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { protectOrderMargin, setAutoProfitProtection } from "@/lib/actions/profit-protection";
import { syncAmazonEmailsNow } from "@/lib/actions/amazon-email";
import { setAutoRestockFulfilledListings } from "@/lib/actions/orders";

export type FulfillmentStage = "AWAITING" | "PURCHASED" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED" | "REFUNDED";

export type FulfillmentOrderRow = {
  id: string;
  ebayOrderId: string;
  ebayListingId: string | null;
  ebayUrl: string | null;
  title: string;
  imageUrl: string | null;
  buyerUsername: string;
  saleDate: string;
  quantity: number;
  stage: FulfillmentStage;
  shipByDate: string | null;
  variation: string | null;
  amazonTitle: string | null;
  amazonOrderId: string | null;
  amazonUrl: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  amazonTrackingUrl: string | null;
  trackingLookupError: string | null;
  trackingSynced: boolean;
  trackingError: string | null;
  revenueCents: number;
  ebayFeeCents: number;
  costCents: number | null;
  costVerified: boolean;
  profitCents: number | null;
  matchConfidence: number | null;
  needsSource: boolean;
  profitProtectionStatus: string | null;
  profitProtectionNewPriceCents: number | null;
  profitProtectionError: string | null;
  suggestedProtectedPriceCents: number | null;
};

type Tab = "ALL" | "NEEDS_ACTION" | "PURCHASED" | "IN_TRANSIT" | "DELIVERED" | "EXCEPTIONS";

const stageMeta: Record<FulfillmentStage, { label: string; tone: "amber" | "indigo" | "green" | "red" | "slate" }> = {
  AWAITING: { label: "Awaiting purchase", tone: "amber" },
  PURCHASED: { label: "Purchased", tone: "indigo" },
  IN_TRANSIT: { label: "In transit", tone: "indigo" },
  DELIVERED: { label: "Delivered", tone: "green" },
  CANCELLED: { label: "Cancelled", tone: "red" },
  REFUNDED: { label: "Refunded", tone: "slate" },
};

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(value));
}

function tabMatches(order: FulfillmentOrderRow, tab: Tab): boolean {
  const protectionNeedsReview = order.profitProtectionStatus === "REVIEW_REQUIRED" || order.profitProtectionStatus === "FAILED";
  if (tab === "ALL") return true;
  if (tab === "NEEDS_ACTION") return order.stage === "AWAITING" || order.needsSource || !!order.trackingError || protectionNeedsReview;
  if (tab === "EXCEPTIONS") return order.stage === "CANCELLED" || order.stage === "REFUNDED" || !!order.trackingError || protectionNeedsReview;
  return order.stage === tab;
}

function trackingUrl(carrier: string | null, tracking: string): string {
  const normalized = carrier?.toLowerCase() ?? "";
  if (normalized.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
  if (normalized.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
  if (normalized.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${carrier ?? "package"} ${tracking}`)}`;
}

export function OrdersView({ orders, fetchError, profitProtectionEnabled, autoRestockEnabled, sitewideDiscountBps }: { orders: FulfillmentOrderRow[]; fetchError: string | null; profitProtectionEnabled: boolean; autoRestockEnabled: boolean; sitewideDiscountBps: number }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("ALL");
  const [sort, setSort] = useState<"NEWEST" | "SHIP_BY" | "PROFIT">("NEWEST");
  const [renderedAt] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();
  const [protectionEnabled, setProtectionEnabled] = useState(profitProtectionEnabled);
  const [protectionMessage, setProtectionMessage] = useState<string | null>(null);
  const [restockEnabled, setRestockEnabled] = useState(autoRestockEnabled);
  const [restockMessage, setRestockMessage] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [orderOverrides, setOrderOverrides] = useState<Record<string, Partial<FulfillmentOrderRow>>>({});
  const [retryingOrderId, setRetryingOrderId] = useState<string | null>(null);
  const displayOrders = useMemo(() => orders.map((order) => ({ ...order, ...orderOverrides[order.id] })), [orderOverrides, orders]);

  function toggleProfitProtection() {
    const nextEnabled = !protectionEnabled;
    setProtectionEnabled(nextEnabled);
    setProtectionMessage(null);
    startTransition(async () => {
      try {
        await setAutoProfitProtection(nextEnabled);
        if (!nextEnabled) {
          setProtectionMessage("Automatic protection is off. You can still protect individual orders.");
        } else {
          setProtectionMessage("Protection is on. Verified orders will be checked automatically; use an order's Protect button for an immediate update.");
        }
      } catch {
        setProtectionEnabled(!nextEnabled);
        setProtectionMessage("Could not update profit protection. Please try again.");
      }
    });
  }

  function protectOneOrder(orderId: string) {
    setProtectionMessage(null);
    setRetryingOrderId(orderId);
    startTransition(async () => {
      try {
        const result = await protectOrderMargin(orderId);
        if ("error" in result) {
          setProtectionMessage(result.error ?? "Could not protect this order.");
        } else if (result.summary.relisted > 0) {
          setProtectionMessage("The ended item was relisted on eBay at the protected price.");
        } else if (result.summary.adjusted > 0) {
          setProtectionMessage("The future listing price was adjusted.");
        } else if (result.summary.protected > 0) {
          setProtectionMessage("This listing already meets the protected target.");
        } else if (result.summary.review > 0 || result.summary.failed > 0) {
          setProtectionMessage("The price could not be changed automatically. Review the listing details below.");
        } else {
          setProtectionMessage("No price adjustment was needed.");
        }
        if (!("error" in result) && result.order) {
          setOrderOverrides((current) => ({
            ...current,
            [orderId]: {
              profitProtectionStatus: result.order?.profitProtectionStatus ?? null,
              profitProtectionNewPriceCents: result.order?.profitProtectionNewPriceCents ?? null,
              profitProtectionError: result.order?.profitProtectionError ?? null,
              suggestedProtectedPriceCents: result.order?.profitProtectionStatus === "FAILED"
                ? orders.find((order) => order.id === orderId)?.suggestedProtectedPriceCents ?? null
                : null,
            },
          }));
        }
      } catch {
        setProtectionMessage("Could not update the eBay listing. Please try again.");
      } finally {
        setRetryingOrderId(null);
      }
    });
  }

  function toggleAutoRestock() {
    const enabled = !restockEnabled;
    const previous = restockEnabled;
    setRestockEnabled(enabled);
    setRestockMessage(null);
    startTransition(async () => {
      try {
        const result = await setAutoRestockFulfilledListings(enabled);
        if (!enabled) {
          setRestockMessage("Automatic stock refill is off.");
        } else if (result.warning) {
          setRestockMessage(`Automatic stock refill is on, but the immediate check failed: ${result.warning}`);
        } else {
          const count = result.restock?.restocked ?? 0;
          setRestockMessage(`Automatic stock refill is on. ${count} low-stock listing${count === 1 ? " was" : "s were"} refilled to 5 now.`);
        }
        router.refresh();
      } catch {
        setRestockEnabled(previous);
        setRestockMessage("Could not update automatic stock refill. Please try again.");
      }
    });
  }

  function refreshFulfillment() {
    setRefreshMessage("Checking Amazon order, shipment, delivery, and tracking emails…");
    startTransition(async () => {
      try {
        const result = await syncAmazonEmailsNow();
        if ("error" in result) {
          setRefreshMessage(result.error ?? "Amazon email refresh failed.");
          return;
        }
        const resolution = result.trackingResolution;
        const details = [
          `${result.imported} Amazon update${result.imported === 1 ? "" : "s"}`,
          `${result.matched} order match${result.matched === 1 ? "" : "es"}`,
          `${resolution.resolved} tracking number${resolution.resolved === 1 ? "" : "s"} resolved`,
          `${result.tracking.uploaded} sent to eBay`,
        ];
        if (resolution.pending) details.push(`${resolution.pending} tracking link${resolution.pending === 1 ? " needs" : "s need"} Amazon sign-in or another update`);
        if (result.tracking.failed) details.push(`${result.tracking.failed} eBay update${result.tracking.failed === 1 ? "" : "s"} failed`);
        if (result.restock.restocked) details.push(`${result.restock.restocked} listing${result.restock.restocked === 1 ? "" : "s"} refilled to 5`);
        if (result.restock.failed) details.push(`${result.restock.failed} stock refill${result.restock.failed === 1 ? "" : "s"} failed`);
        if (result.restockError) details.push("stock check unavailable");
        setRefreshMessage(`Refresh complete: ${details.join(" · ")}.`);
        router.refresh();
      } catch {
        setRefreshMessage("Could not complete the Amazon and eBay refresh. Please try again.");
      }
    });
  }

  const tabCounts = useMemo(() => ({
    ALL: displayOrders.length,
    NEEDS_ACTION: displayOrders.filter((order) => tabMatches(order, "NEEDS_ACTION")).length,
    PURCHASED: displayOrders.filter((order) => order.stage === "PURCHASED").length,
    IN_TRANSIT: displayOrders.filter((order) => order.stage === "IN_TRANSIT").length,
    DELIVERED: displayOrders.filter((order) => order.stage === "DELIVERED").length,
    EXCEPTIONS: displayOrders.filter((order) => tabMatches(order, "EXCEPTIONS")).length,
  }), [displayOrders]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return displayOrders
      .filter((order) => tabMatches(order, tab))
      .filter((order) => !needle || [order.ebayOrderId, order.ebayListingId ?? "", order.title, order.buyerUsername, order.amazonOrderId ?? "", order.amazonTitle ?? "", order.trackingNumber ?? ""].some((value) => value.toLowerCase().includes(needle)))
      .sort((a, b) => {
        if (sort === "PROFIT") return (b.profitCents ?? -Infinity) - (a.profitCents ?? -Infinity);
        if (sort === "SHIP_BY") return (a.shipByDate ? new Date(a.shipByDate).getTime() : Infinity) - (b.shipByDate ? new Date(b.shipByDate).getTime() : Infinity);
        return new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime();
      });
  }, [displayOrders, query, sort, tab]);

  const realizedProfit = displayOrders.filter((order) => order.costVerified && order.profitCents !== null).reduce((sum, order) => sum + (order.profitCents ?? 0), 0);
  const revenue = displayOrders.reduce((sum, order) => sum + order.revenueCents, 0);
  const delivered = displayOrders.filter((order) => order.stage === "DELIVERED").length;

  const tabs: { value: Tab; label: string }[] = [
    { value: "ALL", label: "All orders" },
    { value: "NEEDS_ACTION", label: "Needs action" },
    { value: "PURCHASED", label: "Purchased" },
    { value: "IN_TRANSIT", label: "In transit" },
    { value: "DELIVERED", label: "Delivered" },
    { value: "EXCEPTIONS", label: "Exceptions" },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Needs action" value={tabCounts.NEEDS_ACTION.toLocaleString()} sub="Orders requiring your attention" tone={tabCounts.NEEDS_ACTION ? "negative" : "positive"} />
        <StatCard label="In transit" value={tabCounts.IN_TRANSIT.toLocaleString()} sub="Purchased and on the way" />
        <StatCard label="Delivered" value={delivered.toLocaleString()} sub={`${displayOrders.length.toLocaleString()} total orders`} tone="positive" />
        <StatCard label="Verified profit" value={formatCents(realizedProfit)} sub={`${formatCents(revenue)} total revenue`} tone={realizedProfit >= 0 ? "positive" : "negative"} />
      </div>

      <Card className="overflow-hidden border-indigo-200 bg-gradient-to-r from-indigo-50/80 via-white to-emerald-50/60">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-slate-950">Verified profit protection</h2>
              <Badge tone={protectionEnabled ? "green" : "slate"}>{protectionEnabled ? "Automatic" : "Optional"}</Badge>
            </div>
            <p className="mt-1.5 text-sm leading-6 text-slate-600">When a matched Amazon purchase proves an order earned less than both 5% net margin and $7 net profit, Sellfinity raises that active eBay listing for future orders. Expensive items target $7 instead of exceeding the cap; estimated costs never trigger a change.{sitewideDiscountBps > 0 ? ` Prices are grossed up for your ${(sitewideDiscountBps / 100).toFixed(2).replace(/\.00$/, "")}% sitewide eBay discount.` : ""}</p>
            {protectionMessage && <p className="mt-2 text-sm font-medium text-indigo-700" role="status">{protectionMessage}</p>}
          </div>
          <Button variant={protectionEnabled ? "secondary" : "primary"} disabled={pending} onClick={toggleProfitProtection} className="shrink-0">
            {pending ? "Updating…" : protectionEnabled ? "Turn off automatic" : "Protect future orders"}
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden border-emerald-200 bg-gradient-to-r from-emerald-50/80 via-white to-sky-50/60">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-slate-950">Automatic stock refill</h2>
              <Badge tone={restockEnabled ? "green" : "slate"}>{restockEnabled ? "On" : "Off"}</Badge>
            </div>
            <p className="mt-1.5 text-sm leading-6 text-slate-600">After fulfillment refreshes, Sellfinity checks the live eBay quantity of active listings that have sold. When stock is 0 or 1, it resets the listing to 5. Listings whose live quantity eBay does not confirm are left unchanged.</p>
            {restockMessage && <p className="mt-2 text-sm font-medium text-emerald-700" role="status">{restockMessage}</p>}
          </div>
          <Button variant={restockEnabled ? "secondary" : "primary"} disabled={pending} onClick={toggleAutoRestock} className="shrink-0">
            {pending ? "Updating…" : restockEnabled ? "Turn off auto-restock" : "Turn on auto-restock"}
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto border-b border-slate-200 bg-slate-50/70 px-3 pt-3">
          <div className="flex min-w-max gap-1" role="tablist" aria-label="Fulfillment status">
            {tabs.map((item) => (
              <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} onClick={() => setTab(item.value)} className={cx("rounded-t-lg border-b-2 px-3 py-2.5 text-sm font-medium transition-colors", tab === item.value ? "border-indigo-600 bg-white text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-900")}>
                {item.label} <span className={cx("ml-1 rounded-full px-1.5 py-0.5 text-[11px]", tab === item.value ? "bg-indigo-100 text-indigo-700" : "bg-slate-200 text-slate-600")}>{tabCounts[item.value]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-4">
          <div className="min-w-[260px] flex-1"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search order, buyer, item, Amazon order, or tracking…" aria-label="Search fulfillment orders" /></div>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700" aria-label="Sort orders">
            <option value="NEWEST">Newest first</option><option value="SHIP_BY">Ship-by date</option><option value="PROFIT">Highest profit</option>
          </select>
          <Button variant="secondary" disabled={pending} onClick={refreshFulfillment}>{pending ? "Checking email…" : "↻ Refresh Amazon & eBay"}</Button>
        </div>

        {refreshMessage && <p className="border-b border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800" role="status">{refreshMessage}</p>}

        {fetchError && <p className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Live status is temporarily unavailable: {fetchError}</p>}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1240px] text-sm">
            <thead className="bg-white text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr><th className="px-5 py-3">Order</th><th className="px-4 py-3">Item &amp; buyer</th><th className="px-4 py-3">Fulfillment</th><th className="px-4 py-3">Tracking</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3 text-right">Costs</th><th className="px-4 py-3 text-right">Profit</th><th className="px-4 py-3">Next step</th></tr>
            </thead>
            <tbody>
              {filtered.map((order) => {
                const meta = stageMeta[order.stage];
                const overdue = order.stage === "AWAITING" && order.shipByDate && new Date(order.shipByDate).getTime() < renderedAt;
                const protectionFailed = order.profitProtectionStatus === "FAILED";
                const protectionReview = order.profitProtectionStatus === "REVIEW_REQUIRED";
                return (
                  <tr key={order.id} className="border-t border-slate-100 align-top hover:bg-slate-50/70">
                    <td className="whitespace-nowrap px-5 py-4"><p className="font-semibold text-slate-900">#{order.ebayOrderId}</p><p className="mt-1 text-xs text-slate-500">{displayDate(order.saleDate)}</p>{order.shipByDate && <p className={cx("mt-1 text-xs", overdue ? "font-semibold text-red-600" : "text-slate-500")}>Ship by {displayDate(order.shipByDate)}</p>}</td>
                    <td className="max-w-[330px] px-4 py-4"><div className="flex gap-3">{order.imageUrl ? /* External marketplace image hosts are dynamic. */ // eslint-disable-next-line @next/next/no-img-element
                      <img src={order.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg border border-slate-200 bg-white object-contain" /> : <div className="h-12 w-12 shrink-0 rounded-lg bg-slate-100" />}<div className="min-w-0">{order.ebayUrl ? <a href={order.ebayUrl} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium text-slate-900 hover:text-indigo-700">{order.title}</a> : <p className="line-clamp-2 font-medium text-slate-900">{order.title}</p>}<p className="mt-1 text-xs text-slate-500">{order.buyerUsername} · Qty {order.quantity}</p>{order.variation && <p className="mt-0.5 truncate text-xs text-violet-700">{order.variation}</p>}</div></div></td>
                    <td className="px-4 py-4"><Badge tone={meta.tone}>{meta.label}</Badge>{order.amazonOrderId && <p className="mt-2 text-xs text-slate-500">Amazon #{order.amazonOrderId}</p>}{order.matchConfidence !== null && <p className="mt-0.5 text-[11px] text-slate-400">{order.matchConfidence}% source match</p>}</td>
                    <td className="max-w-[220px] px-4 py-4">{order.trackingNumber ? <><a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="break-all font-medium text-indigo-700 hover:underline">{order.trackingNumber}</a><p className="mt-1 text-xs text-slate-500">{order.carrier ?? "Carrier pending"}{order.trackingSynced ? " · sent to eBay" : " · waiting for eBay"}</p></> : order.amazonTrackingUrl ? <><a href={order.amazonTrackingUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 hover:underline">Open Amazon tracking ↗</a><p className="mt-1 text-xs text-amber-700">Tracking number pending</p></> : <span className="text-slate-400">Not available yet</span>}{order.trackingLookupError && <p className="mt-1 line-clamp-3 text-xs text-amber-700" title={order.trackingLookupError}>{order.trackingLookupError}</p>}{order.trackingError && <p className="mt-1 line-clamp-2 text-xs text-red-600" title={order.trackingError}>{order.trackingError}</p>}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-right"><p className="font-semibold tabular-nums text-slate-900">{formatCents(order.revenueCents)}</p><p className="mt-1 text-[11px] text-slate-400">eBay sale</p></td>
                    <td className="whitespace-nowrap px-4 py-4 text-right"><p className="font-medium tabular-nums text-slate-700">{order.costCents === null ? "—" : formatCents(order.costCents + order.ebayFeeCents)}</p><p className="mt-1 text-[11px] text-slate-400">{order.costVerified ? "Verified" : "Estimated"} · incl. fees</p></td>
                    <td className="whitespace-nowrap px-4 py-4 text-right">
                      <p className={cx("font-semibold tabular-nums", order.profitCents === null ? "text-slate-400" : order.profitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{order.profitCents === null ? "—" : formatCents(order.profitCents)}</p>
                      {order.profitProtectionStatus === "ADJUSTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Future price {formatCents(order.profitProtectionNewPriceCents)}</p>}
                      {order.profitProtectionStatus === "RELISTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Relisted at {formatCents(order.profitProtectionNewPriceCents)}</p>}
                      {order.profitProtectionStatus === "ALREADY_PROTECTED" && <p className="mt-1 text-[11px] font-medium text-emerald-700">Future price protected</p>}
                      {(protectionReview || protectionFailed) && <p className={cx("mt-1 max-w-[180px] whitespace-normal text-[11px]", protectionFailed ? "text-red-600" : "text-amber-700")} title={order.profitProtectionError ?? undefined}>{protectionFailed ? "Price update failed" : "Listing review needed"}</p>}
                    </td>
                    <td className="px-4 py-4">
                      {order.stage === "AWAITING" ? order.amazonUrl ? <a href={order.amazonUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Buy on Amazon ↗</a> : <a href="/listings" className="inline-flex rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">Find source</a> : protectionReview ? <a href="/listings" className="inline-flex rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Review listing</a> : (order.suggestedProtectedPriceCents !== null || protectionFailed) ? <Button size="sm" variant={protectionFailed ? "secondary" : "primary"} disabled={pending} onClick={() => protectOneOrder(order.id)}>{retryingOrderId === order.id ? "Contacting eBay…" : protectionFailed ? "Retry protection" : `Protect at ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}`}</Button> : order.trackingNumber ? <a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Track package ↗</a> : <span className="text-xs text-slate-400">No action needed</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="px-6 py-16 text-center"><p className="font-semibold text-slate-900">No orders in this view</p><p className="mt-1 text-sm text-slate-500">Try another status tab or clear your search.</p></div>}
      </Card>
    </div>
  );
}
