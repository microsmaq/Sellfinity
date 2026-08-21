"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";
import { formatCents } from "@/lib/money";
import { protectOrderMargin, setAutoProfitProtection } from "@/lib/actions/profit-protection";
import { syncAmazonEmailsNow } from "@/lib/actions/amazon-email";
import { markOrderCancelled, reassignAmazonPurchase, setAutoRestockFulfilledListings, submitManualOrderTracking } from "@/lib/actions/orders";
import { fulfillmentNeedsAction, type FulfillmentStage } from "@/lib/orders/fulfillment-stage";

export type FulfillmentOrderRow = {
  id: string;
  ebayOrderId: string;
  ebayListingId: string | null;
  ebayUrl: string | null;
  title: string;
  sku: string;
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
  soldUnitPriceCents: number;
  listingPriceCents: number | null;
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
  verifiedWinner: boolean;
  priceLocked: boolean;
  winnerProtectedUntil: string | null;
};

type Tab = "ALL" | "NEEDS_ACTION" | "PURCHASED" | "IN_TRANSIT" | "DELIVERED" | "EXCEPTIONS";

type RefreshRun = {
  startedAt: number;
  server: "running" | "complete" | "error";
  helper: "starting" | "running" | "complete" | "unavailable";
  trackingTotal: number;
  trackingProcessed: number;
  trackingFound: number;
  result: string | null;
};

function elapsedLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

const stageMeta: Record<FulfillmentStage, { label: string; tone: "amber" | "indigo" | "green" | "red" | "slate" }> = {
  AWAITING: { label: "Awaiting purchase", tone: "amber" },
  PURCHASED: { label: "Awaiting Amazon shipment", tone: "indigo" },
  IN_TRANSIT: { label: "Shipped", tone: "indigo" },
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
  if (tab === "NEEDS_ACTION") {
    return fulfillmentNeedsAction({
      stage: order.stage,
      trackingNumber: order.trackingNumber,
      needsSource: order.needsSource,
      trackingError: order.trackingError,
      protectionNeedsReview,
    });
  }
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
  const [tab, setTab] = useState<Tab>("NEEDS_ACTION");
  const [sort, setSort] = useState<"NEWEST" | "SHIP_BY" | "PROFIT">("NEWEST");
  const [renderedAt] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();
  const [protectionEnabled, setProtectionEnabled] = useState(profitProtectionEnabled);
  const [protectionMessage, setProtectionMessage] = useState<string | null>(null);
  const [restockEnabled, setRestockEnabled] = useState(autoRestockEnabled);
  const [restockMessage, setRestockMessage] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshRun, setRefreshRun] = useState<RefreshRun | null>(null);
  const [refreshElapsed, setRefreshElapsed] = useState(0);
  const [orderOverrides, setOrderOverrides] = useState<Record<string, Partial<FulfillmentOrderRow>>>({});
  const [retryingOrderId, setRetryingOrderId] = useState<string | null>(null);
  const [manualTracking, setManualTracking] = useState<Record<string, string>>({});
  const [savingTrackingOrderId, setSavingTrackingOrderId] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [reassigningOrderId, setReassigningOrderId] = useState<string | null>(null);
  const displayOrders = useMemo(() => orders.map((order) => ({ ...order, ...orderOverrides[order.id] })), [orderOverrides, orders]);

  function duplicateAwaitingOrders(order: FulfillmentOrderRow) {
    return displayOrders.filter((candidate) =>
      candidate.id !== order.id
      && candidate.sku.toUpperCase() === order.sku.toUpperCase()
      && candidate.amazonOrderId === null
      && candidate.stage === "AWAITING"
    );
  }

  function moveAmazonMatch(source: FulfillmentOrderRow, target: FulfillmentOrderRow) {
    if (!window.confirm(`Move Amazon order ${source.amazonOrderId} from ${source.buyerUsername} to ${target.buyerUsername}?`)) return;
    setReassigningOrderId(source.id);
    startTransition(async () => {
      const result = await reassignAmazonPurchase(source.id, target.id);
      setReassigningOrderId(null);
      if (result.error) {
        setRefreshMessage(result.error);
        return;
      }
      setRefreshMessage(`Amazon order moved to ${target.buyerUsername}.`);
      router.refresh();
    });
  }

  useEffect(() => {
    function receiveExtensionTracking(event: Event) {
      const detail = (event as CustomEvent<{ orderId?: string; trackingNumber?: string }>).detail;
      if (!detail?.orderId || !detail.trackingNumber) return;
      setManualTracking((current) => ({ ...current, [detail.orderId!]: detail.trackingNumber! }));
      // Version 1.1.0 emits tracking results but not aggregate progress. Keep
      // its counters moving; 1.1.1 follows with authoritative totals.
      setRefreshRun((current) => current ? {
        ...current,
        trackingProcessed: Math.min(current.trackingTotal, current.trackingProcessed + 1),
        trackingFound: current.trackingFound + 1,
      } : current);
    }
    function receiveHelperProgress(event: Event) {
      const detail = (event as CustomEvent<{ status?: "running" | "complete"; total?: number; processed?: number; found?: number }>).detail;
      if (!detail?.status) return;
      const helperStatus = detail.status;
      setRefreshRun((current) => current ? {
        ...current,
        helper: helperStatus,
        trackingTotal: detail.total ?? current.trackingTotal,
        trackingProcessed: detail.processed ?? current.trackingProcessed,
        trackingFound: detail.found ?? current.trackingFound,
      } : current);
    }
    document.addEventListener("sellfinity:tracking-filled", receiveExtensionTracking);
    document.addEventListener("sellfinity:tracking-helper-progress", receiveHelperProgress);
    return () => {
      document.removeEventListener("sellfinity:tracking-filled", receiveExtensionTracking);
      document.removeEventListener("sellfinity:tracking-helper-progress", receiveHelperProgress);
    };
  }, []);

  useEffect(() => {
    if (!refreshRun || (refreshRun.server !== "running" && refreshRun.helper !== "running" && refreshRun.helper !== "starting")) return;
    const updateElapsed = () => setRefreshElapsed(Math.floor((Date.now() - refreshRun.startedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [refreshRun]);

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
    const order = orders.find((item) => item.id === orderId);
    const confirmsWinnerChange = Boolean(order?.verifiedWinner || order?.priceLocked);
    if (confirmsWinnerChange && !window.confirm(`“${order?.title ?? "This listing"}” has a protected price${order?.verifiedWinner ? " as a Verified Winner" : " after a profitable sale"}. Apply the suggested future price anyway?`)) return;
    setProtectionMessage(null);
    setRetryingOrderId(orderId);
    startTransition(async () => {
      try {
        const result = await protectOrderMargin(orderId, confirmsWinnerChange);
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

  function submitTracking(order: FulfillmentOrderRow, visibleValue?: string) {
    const domValue = document.querySelector<HTMLInputElement>(`input[data-order-id="${CSS.escape(order.id)}"]`)?.value;
    const value = [visibleValue, manualTracking[order.id], domValue]
      .find((candidate) => candidate?.trim())
      ?.trim() ?? "";
    if (!value) return;
    setSavingTrackingOrderId(order.id);
    startTransition(async () => {
      try {
        const result = await submitManualOrderTracking(order.id, value);
        if ("error" in result) {
          setRefreshMessage(result.error ?? "eBay rejected the tracking update.");
          return;
        }
        setOrderOverrides((current) => ({ ...current, [order.id]: {
          trackingNumber: result.trackingNumber,
          carrier: result.carrier,
          trackingSynced: result.syncedToEbay,
          trackingError: null,
          stage: order.stage === "DELIVERED" ? "DELIVERED" : "IN_TRANSIT",
        } }));
        setManualTracking((current) => ({ ...current, [order.id]: "" }));
        router.refresh();
      } catch {
        // Keep the field populated so the user can retry without adding UI clutter.
      } finally {
        setSavingTrackingOrderId(null);
      }
    });
  }

  function refreshFulfillment() {
    const trackingTotal = displayOrders.filter((order) => !order.trackingNumber && !!order.amazonTrackingUrl).length;
    const startedAt = Date.now();
    setRefreshElapsed(0);
    setRefreshRun({
      startedAt,
      server: "running",
      helper: trackingTotal ? "starting" : "complete",
      trackingTotal,
      trackingProcessed: 0,
      trackingFound: 0,
      result: null,
    });
    setRefreshMessage("Checking Amazon order, shipment, delivery, and tracking emails…");
    // The installed helper discovers tracking links from rendered fulfillment
    // rows. Put every missing-tracking order in the default view before asking
    // it to scan, even if Refresh was clicked from another tab or after search.
    setTab("NEEDS_ACTION");
    setQuery("");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.dispatchEvent(new CustomEvent("sellfinity:bulk-tracking-refresh"));
    }));
    startTransition(async () => {
      try {
        const result = await syncAmazonEmailsNow();
        if ("error" in result) {
          const message = result.error ?? "Amazon email refresh failed.";
          setRefreshMessage(message);
          setRefreshRun((current) => current ? { ...current, server: "error", result: message } : current);
          // eBay refresh runs before Amazon email sync. Show any cancellation
          // updates it saved even when Gmail later fails or needs reconnecting.
          router.refresh();
          return;
        }
        const resolution = result.trackingResolution;
        const details = [
          `${result.imported} Amazon update${result.imported === 1 ? "" : "s"}`,
          `${result.matched} order match${result.matched === 1 ? "" : "es"}`,
          `${resolution.resolved} tracking number${resolution.resolved === 1 ? "" : "s"} resolved`,
          `${result.tracking.uploaded} sent to eBay`,
        ];
        if (result.tracking.savedLocally) details.push(`${result.tracking.savedLocally} tracking ID${result.tracking.savedLocally === 1 ? "" : "s"} saved`);
        if (resolution.pending) details.push(`${resolution.pending} tracking ID${resolution.pending === 1 ? " is" : "s are"} still pending`);
        if (result.tracking.failed) details.push(`${result.tracking.failed} eBay update${result.tracking.failed === 1 ? "" : "s"} failed`);
        if (result.protection) {
          const directAdjustments = Math.max(0, result.protection.adjusted - result.protection.relisted);
          if (directAdjustments) details.push(`${directAdjustments} future price${directAdjustments === 1 ? "" : "s"} protected`);
          if (result.protection.relisted) details.push(`${result.protection.relisted} ended listing${result.protection.relisted === 1 ? "" : "s"} relisted at a protected price`);
          if (result.protection.protected) details.push(`${result.protection.protected} listing${result.protection.protected === 1 ? " was" : "s were"} already protected`);
          if (result.protection.review) details.push(`${result.protection.review} price${result.protection.review === 1 ? "" : "s"} need review`);
          if (result.protection.failed) details.push(`${result.protection.failed} price update${result.protection.failed === 1 ? "" : "s"} failed`);
          if (result.protection.winnerLocked) details.push(`${result.protection.winnerLocked} profitable listing price${result.protection.winnerLocked === 1 ? " was" : "s were"} preserved`);
          if (!result.protection.eligible && result.protection.checked) details.push(`${result.protection.checked} verified margin${result.protection.checked === 1 ? "" : "s"} checked`);
          if (result.protection.awaitingVerification) details.push(`${result.protection.awaitingVerification} price${result.protection.awaitingVerification === 1 ? " was" : "s were"} left unchanged because the Amazon cost is still estimated`);
        }
        if (result.restock.restocked) details.push(`${result.restock.restocked} listing${result.restock.restocked === 1 ? "" : "s"} refilled to 5`);
        if (result.restock.failed) details.push(`${result.restock.failed} stock refill${result.restock.failed === 1 ? "" : "s"} failed`);
        if (result.restockError) details.push("stock check unavailable");
        setRefreshMessage(`Refresh complete: ${details.join(" · ")}.`);
        setRefreshRun((current) => current ? {
   …3509 tokens truncated…>}

        {fetchError && <p className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Live status is temporarily unavailable: {fetchError}</p>}

        <div className="space-y-3 bg-slate-50/60 p-3 md:hidden">
          {filtered.map((order) => {
            const meta = stageMeta[order.stage];
            const overdue = order.stage === "AWAITING" && order.shipByDate && new Date(order.shipByDate).getTime() < renderedAt;
            const protectionFailed = order.profitProtectionStatus === "FAILED";
            const protectionReview = order.profitProtectionStatus === "REVIEW_REQUIRED";
            const protectionApplied = ["ADJUSTED", "RELISTED", "ALREADY_PROTECTED"].includes(order.profitProtectionStatus ?? "");
            const awaitingVerifiedCost = order.profitCents !== null
              && order.profitCents < 0
              && !order.costVerified
              && order.profitProtectionStatus === null;
            const priceChangedSinceSale = awaitingVerifiedCost
              && order.listingPriceCents !== null
              && order.listingPriceCents !== order.soldUnitPriceCents;
            const futurePriceCents = protectionApplied || protectionFailed || protectionReview
              ? order.profitProtectionNewPriceCents
              : order.suggestedProtectedPriceCents;
            return (
              <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  {order.imageUrl
                    ? <img src={order.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl border border-slate-200 bg-white object-contain" />
                    : <div className="h-14 w-14 shrink-0 rounded-xl bg-slate-100" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-1.5"><Badge tone={meta.tone}>{meta.label}</Badge>{order.verifiedWinner && <Badge tone="amber">🏆 Winner</Badge>}{!order.verifiedWinner && order.priceLocked && <Badge tone="indigo">🔒 Price locked</Badge>}</div><span className="text-[11px] text-slate-400">#{order.ebayOrderId}</span></div>
                    <p className="mt-2 line-clamp-2 text-[13px] font-semibold leading-5 text-slate-950">{order.title}</p>
                    <p className="mt-1 text-xs text-slate-500">{order.buyerUsername} · Qty {order.quantity}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 rounded-xl bg-slate-50 p-3 text-center">
                  <div><p className="text-[10px] uppercase text-slate-400">Revenue</p><p className="mt-1 text-sm font-bold">{formatCents(order.revenueCents)}</p></div>
                  <div className="border-x border-slate-200"><p className="text-[10px] uppercase text-slate-400">Cost</p><p className="mt-1 text-sm font-bold">{order.costCents === null ? "—" : formatCents(order.costCents + order.ebayFeeCents)}</p></div>
                  <div><p className="text-[10px] uppercase text-slate-400">Profit</p><p className={cx("mt-1 text-sm font-bold", order.profitCents === null ? "text-slate-400" : order.profitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{order.profitCents === null ? "—" : formatCents(order.profitCents)}</p></div>
                </div>
                {awaitingVerifiedCost && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                    <p className="text-xs font-semibold text-amber-900">{priceChangedSinceSale ? `Current price ${formatCents(order.listingPriceCents!)} · sale price ${formatCents(order.soldUnitPriceCents)}` : "Price unchanged · awaiting verified cost"}</p>
                  </div>
                )}
                {futurePriceCents !== null && (
                  <div className={cx("mt-3 flex items-center justify-between rounded-xl border px-3 py-2.5", protectionApplied ? "border-emerald-200 bg-emerald-50" : protectionFailed ? "border-red-200 bg-red-50" : "border-indigo-200 bg-indigo-50")}>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{protectionApplied ? "Future listing price" : order.verifiedWinner || order.priceLocked ? "Locked price · change requires confirmation" : protectionFailed || protectionReview ? "Target future price" : "Planned future price"}</p>
                      <p className={cx("mt-0.5 text-lg font-bold tabular-nums", protectionApplied ? "text-emerald-700" : protectionFailed ? "text-red-700" : "text-indigo-700")}>{formatCents(futurePriceCents)}</p>
                    </div>
                    <Badge tone={protectionApplied ? "green" : protectionFailed ? "red" : "indigo"}>{order.profitProtectionStatus === "RELISTED" ? "Relisted" : protectionApplied ? "Protected" : protectionFailed ? "Retry needed" : protectionReview ? "Review" : "Ready to protect"}</Badge>
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                  <span className={overdue ? "font-semibold text-red-600" : "text-slate-500"}>{order.shipByDate ? `Ship by ${displayDate(order.shipByDate)}` : displayDate(order.saleDate)}</span>
                  {order.stage === "AWAITING" && order.amazonUrl
                    ? <a href={order.amazonUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-xl bg-indigo-600 px-3 font-semibold text-white">Buy on Amazon</a>
                    : protectionReview
                      ? <a href="/listings" className="inline-flex min-h-10 items-center rounded-xl border border-amber-200 bg-amber-50 px-3 font-semibold text-amber-800">Review listing</a>
                      : order.suggestedProtectedPriceCents !== null || protectionFailed
                        ? <Button size="sm" variant={protectionFailed ? "secondary" : "primary"} disabled={pending} onClick={() => protectOneOrder(order.id)}>{retryingOrderId === order.id ? "Contacting eBay…" : protectionFailed ? "Retry protection" : order.verifiedWinner || order.priceLocked ? `Confirm ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}` : `Protect at ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}`}</Button>
                        : order.trackingNumber
                          ? <a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-xl border border-slate-300 px-3 font-semibold text-slate-700">Track</a>
                          : <span className="text-slate-400">No action needed</span>}
                </div>
                {order.amazonOrderId && duplicateAwaitingOrders(order).length > 0 && (
                  <details className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-amber-900">Correct Amazon match</summary>
                    <p className="mt-2 text-[11px] leading-4 text-amber-800">Move this Amazon purchase if it was attached to the wrong buyer.</p>
                    <div className="mt-2 grid gap-2">
                      {duplicateAwaitingOrders(order).map((target) => (
                        <Button key={target.id} size="sm" variant="secondary" disabled={pending || reassigningOrderId === order.id} onClick={() => moveAmazonMatch(order, target)}>
                          {reassigningOrderId === order.id ? "Moving…" : `Move to ${target.buyerUsername}`}
                        </Button>
                      ))}
                    </div>
                  </details>
                )}
              </article>
            );
          })}
        </div>
        <div className="hidden overflow-x-auto md:block">
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
                const awaitingVerifiedCost = order.profitCents !== null
                  && order.profitCents < 0
                  && !order.costVerified
                  && order.profitProtectionStatus === null;
                const priceChangedSinceSale = awaitingVerifiedCost
                  && order.listingPriceCents !== null
                  && order.listingPriceCents !== order.soldUnitPriceCents;
                return (
                  <tr key={order.id} className="border-t border-slate-100 align-top hover:bg-slate-50/70">
                    <td className="whitespace-nowrap px-5 py-4"><p className="font-semibold text-slate-900">#{order.ebayOrderId}</p><p className="mt-1 text-xs text-slate-500">{displayDate(order.saleDate)}</p>{order.shipByDate && <p className={cx("mt-1 text-xs", overdue ? "font-semibold text-red-600" : "text-slate-500")}>Ship by {displayDate(order.shipByDate)}</p>}</td>
                    <td className="max-w-[330px] px-4 py-4"><div className="flex gap-3">{order.imageUrl ? /* External marketplace image hosts are dynamic. */
                      <img src={order.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg border border-slate-200 bg-white object-contain" /> : <div className="h-12 w-12 shrink-0 rounded-lg bg-slate-100" />}<div className="min-w-0">{order.ebayUrl ? <a href={order.ebayUrl} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium text-slate-900 hover:text-indigo-700">{order.title}</a> : <p className="line-clamp-2 font-medium text-slate-900">{order.title}</p>}<p className="mt-1 text-xs text-slate-500">{order.buyerUsername} · Qty {order.quantity}</p>{order.verifiedWinner && <div className="mt-1.5"><Badge tone="amber">🏆 Verified winner · price locked</Badge></div>}{!order.verifiedWinner && order.priceLocked && <div className="mt-1.5"><Badge tone="indigo">🔒 Price locked · profitable sale</Badge></div>}{order.variation && <p className="mt-0.5 truncate text-xs text-violet-700">{order.variation}</p>}</div></div></td>
                    <td className="px-4 py-4"><Badge tone={meta.tone}>{meta.label}</Badge>{order.amazonOrderId && <p className="mt-2 text-xs text-slate-500">Amazon #{order.amazonOrderId}</p>}{order.matchConfidence !== null && <p className="mt-0.5 text-[11px] text-slate-400">{order.matchConfidence}% source match</p>}{order.amazonOrderId && duplicateAwaitingOrders(order).length > 0 && <details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold text-amber-700">Correct match</summary><div className="mt-1.5 grid gap-1">{duplicateAwaitingOrders(order).map((target) => <button key={target.id} type="button" disabled={pending || reassigningOrderId === order.id} onClick={() => moveAmazonMatch(order, target)} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-left text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50">{reassigningOrderId === order.id ? "Moving…" : `Move to ${target.buyerUsername}`}</button>)}</div></details>}</td>
                    <td className="max-w-[240px] px-4 py-4">{order.trackingNumber ? <><a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="break-all font-medium text-indigo-700 hover:underline">{order.trackingNumber}</a><p className="mt-1 text-xs text-slate-500">{order.carrier ?? "Carrier pending"}{order.trackingSynced ? " · sent to eBay" : order.stage === "DELIVERED" ? " · saved" : " · waiting for eBay"}</p></> : <>{order.amazonTrackingUrl ? <><a href={order.amazonTrackingUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 hover:underline">Open Amazon tracking ↗</a><p className="mt-1 text-xs text-amber-700">Tracking number pending</p></> : <span className="text-slate-400">Not available yet</span>}{order.stage !== "CANCELLED" && order.stage !== "REFUNDED" && <div className="mt-2 space-y-1.5"><input data-order-id={order.id} value={manualTracking[order.id] ?? ""} onChange={(event) => setManualTracking((current) => ({ ...current, [order.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") submitTracking(order, event.currentTarget.value); }} placeholder="Enter tracking number" aria-label={`Tracking number for ${order.ebayOrderId}`} className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none" /><Button size="sm" variant="secondary" disabled={pending || savingTrackingOrderId === order.id} onClick={() => submitTracking(order)} className="w-full">{savingTrackingOrderId === order.id ? "Saving…" : order.stage === "DELIVERED" ? "Save tracking" : "Save & mark shipped"}</Button></div>}</>}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-right"><p className="font-semibold tabular-nums text-slate-900">{formatCents(order.revenueCents)}</p><p className="mt-1 text-[11px] text-slate-400">eBay sale</p></td>
                    <td className="whitespace-nowrap px-4 py-4 text-right"><p className="font-medium tabular-nums text-slate-700">{order.costCents === null ? "—" : formatCents(order.costCents + order.ebayFeeCents)}</p><p className="mt-1 text-[11px] text-slate-400">{order.costVerified ? "Verified" : "Estimated"} · incl. fees</p></td>
                    <td className="whitespace-nowrap px-4 py-4 text-right">
                      <p className={cx("font-semibold tabular-nums", order.profitCents === null ? "text-slate-400" : order.profitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{order.profitCents === null ? "—" : formatCents(order.profitCents)}</p>
                      {order.profitProtectionStatus === "ADJUSTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Future listing {formatCents(order.profitProtectionNewPriceCents)} · updated</p>}
                      {order.profitProtectionStatus === "RELISTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Relisted at {formatCents(order.profitProtectionNewPriceCents)}</p>}
                      {order.profitProtectionStatus === "ALREADY_PROTECTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Future listing {formatCents(order.profitProtectionNewPriceCents)} · protected</p>}
                      {order.profitProtectionStatus === null && order.suggestedProtectedPriceCents !== null && <p className={cx("mt-1 text-[11px] font-medium", order.verifiedWinner || order.priceLocked ? "text-amber-700" : "text-indigo-700")}>{order.verifiedWinner || order.priceLocked ? "Price locked · suggested" : "Planned future price"} {formatCents(order.suggestedProtectedPriceCents)}</p>}
                      {(protectionReview || protectionFailed) && order.profitProtectionNewPriceCents !== null && <p className={cx("mt-1 text-[11px] font-medium", protectionFailed ? "text-red-700" : "text-amber-700")}>Target future price {formatCents(order.profitProtectionNewPriceCents)}</p>}
                      {(protectionReview || protectionFailed) && <p className={cx("mt-1 max-w-[180px] whitespace-normal text-[11px]", protectionFailed ? "text-red-600" : "text-amber-700")} title={order.profitProtectionError ?? undefined}>{protectionFailed ? "Price update failed" : "Listing review needed"}</p>}
                      {awaitingVerifiedCost && <p className="mt-1 max-w-[190px] whitespace-normal text-[11px] font-medium leading-4 text-amber-700">{priceChangedSinceSale ? `Current price ${formatCents(order.listingPriceCents!)} · sale price ${formatCents(order.soldUnitPriceCents)}` : "Price unchanged · awaiting verified cost"}</p>}
                    </td>
                    <td className="px-4 py-4">
                      {order.stage === "AWAITING" ? order.amazonUrl ? <a href={order.amazonUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Buy on Amazon ↗</a> : <a href="/listings" className="inline-flex rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">Find source</a> : protectionReview ? <a href="/listings" className="inline-flex rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Review listing</a> : (order.suggestedProtectedPriceCents !== null || protectionFailed) ? <Button size="sm" variant={protectionFailed ? "secondary" : "primary"} disabled={pending} onClick={() => protectOneOrder(order.id)}>{retryingOrderId === order.id ? "Contacting eBay…" : protectionFailed ? "Retry protection" : order.verifiedWinner || order.priceLocked ? `Confirm ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}` : `Protect at ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}`}</Button> : order.trackingNumber ? <a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Track package ↗</a> : <span className="text-xs text-slate-400">No action needed</span>}
                      {order.stage === "AWAITING" && <Button size="sm" variant="secondary" className="mt-2" disabled={pending} onClick={() => cancelOrder(order)}>{cancellingOrderId === order.id ? "Updating…" : "Mark cancelled"}</Button>}
                      {order.trackingNumber && !order.trackingSynced && order.stage !== "CANCELLED" && order.stage !== "REFUNDED" && <Button size="sm" variant="secondary" className="mt-2" disabled={pending} onClick={() => submitTracking(order, order.trackingNumber ?? undefined)}>{savingTrackingOrderId === order.id ? "Sending…" : "Send to eBay"}</Button>}
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
