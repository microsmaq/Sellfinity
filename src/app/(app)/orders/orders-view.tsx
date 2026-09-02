"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, StatCard, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";
import { formatCents } from "@/lib/money";
import { protectOrderMargin, setAutoProfitProtection } from "@/lib/actions/profit-protection";
import { syncAmazonEmailsNow } from "@/lib/actions/amazon-email";
import { linkAmazonPurchase, markOrderCancelled, reassignAmazonPurchase, setAutoRestockFulfilledListings, submitManualOrderTracking, updateFulfillmentAmazonCosts } from "@/lib/actions/orders";
import { fulfillmentActionReason, type FulfillmentActionReason, type FulfillmentStage } from "@/lib/orders/fulfillment-stage";
import { trackingUploadErrorDisposition } from "@/lib/amazon-email/tracking-utils";

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
  ebayFulfilled: boolean;
  revenueCents: number;
  soldUnitPriceCents: number;
  listingPriceCents: number | null;
  ebayFeeCents: number;
  transactionFeeCents: number;
  advertisingFeeCents: number;
  otherEbayCostCents: number;
  shippingLabelCents: number;
  refundCents: number;
  amazonItemCostCents: number | null;
  amazonShippingCents: number;
  amazonTaxCents: number;
  amazonDiscountCents: number;
  financialsActual: boolean;
  ebayFeeDetails: { type: string; amountCents: number }[];
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

type AmazonPriceCheckRun = {
  status: "starting" | "running" | "complete" | "unavailable";
  total: number;
  processed: number;
  found: number;
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
  if (tab === "NEEDS_ACTION") return orderActionReason(order) !== null;
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

function orderActionReason(order: FulfillmentOrderRow): FulfillmentActionReason | null {
  const deliveredTemporaryEbayError = order.stage === "DELIVERED"
    && !!order.trackingError
    && trackingUploadErrorDisposition(order.trackingError) === "RETRYABLE";
  return fulfillmentActionReason({
    stage: order.stage,
    trackingNumber: order.trackingNumber,
    needsSource: order.needsSource,
    trackingError: order.trackingError,
    trackingErrorActionable: !deliveredTemporaryEbayError,
    trackingNeedsSync: !deliveredTemporaryEbayError && Boolean(order.trackingNumber && !order.trackingSynced),
    protectionNeedsReview: order.profitProtectionStatus === "REVIEW_REQUIRED" || order.profitProtectionStatus === "FAILED",
    ebayFulfilled: order.ebayFulfilled,
  });
}

/** Price protection changes one eBay listing, not every historical order that
 * sold from it. Keep the strictest failed target as the single actionable row
 * while preserving every order that still needs its own fulfillment work. */
function consolidatedNeedsActionOrders(orders: FulfillmentOrderRow[]): FulfillmentOrderRow[] {
  const protectionRepresentative = new Map<string, FulfillmentOrderRow>();
  for (const order of orders) {
    if (orderActionReason(order) !== "PRICE_PROTECTION") continue;
    const listingKey = order.ebayListingId ?? `sku:${order.sku}`;
    const current = protectionRepresentative.get(listingKey);
    if (!current
      || (order.profitProtectionNewPriceCents ?? 0) > (current.profitProtectionNewPriceCents ?? 0)
      || ((order.profitProtectionNewPriceCents ?? 0) === (current.profitProtectionNewPriceCents ?? 0)
        && new Date(order.saleDate).getTime() > new Date(current.saleDate).getTime())) {
      protectionRepresentative.set(listingKey, order);
    }
  }
  const representativeIds = new Set([...protectionRepresentative.values()].map((order) => order.id));
  return orders.filter((order) => {
    const reason = orderActionReason(order);
    return reason !== null && (reason !== "PRICE_PROTECTION" || representativeIds.has(order.id));
  });
}

function actionReasonLabel(order: FulfillmentOrderRow): string | null {
  const reason = orderActionReason(order);
  if (reason === "PRICE_PROTECTION") return "Future price needs retry";
  if (reason === "TRACKING") return order.trackingError ? "Tracking update failed" : "Send tracking to eBay";
  if (reason === "FULFILLMENT") return order.needsSource ? "Amazon source needed" : order.stage === "AWAITING" ? "Purchase needed" : "Tracking needed";
  return null;
}

function protectionErrorSummary(message: string | null): string {
  if (!message) return "eBay did not provide a detailed reason. Retry the update; if it fails again, refresh the listing first.";
  if (/25604|product not found|availability not found/i.test(message)) return "eBay lost part of this listing's inventory record. Retry protection to repair the inventory and apply the new price.";
  if (/25001|core inventory service internal error|system error/i.test(message)) return "eBay had a temporary system error. Retry protection; the update will be attempted safely again.";
  if (/500 pixels|picture policy/i.test(message)) return "A listing image is below eBay's minimum size. Retry protection to replace the invalid image and apply the price.";
  if (/ended item|listing.*ended/i.test(message)) return "The eBay listing has ended. Retry protection to relist it at the protected price.";
  return message.length > 260 ? `${message.slice(0, 257)}…` : message;
}

function CostBreakdown({ order, mobile = false }: { order: FulfillmentOrderRow; mobile?: boolean }) {
  if (order.costCents === null) return <span className="text-slate-400">—</span>;
  const total = order.costCents + order.ebayFeeCents;
  const ebayFeeRows: Array<readonly [string, number | null]> = order.ebayFeeDetails.length
    ? order.ebayFeeDetails.map((fee) => [
        `eBay ${fee.type.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}`,
        fee.amountCents,
      ] as const)
    : [["eBay transaction fees", order.transactionFeeCents], ["Advertising", order.advertisingFeeCents]];
  const rows: Array<readonly [string, number | null]> = [
    ["Amazon item", order.amazonItemCostCents],
    ["Amazon shipping", order.amazonShippingCents],
    ["Amazon tax", order.amazonTaxCents],
    ["Amazon discount", order.amazonDiscountCents ? -order.amazonDiscountCents : 0],
    ...ebayFeeRows,
    ["Other eBay fees", order.otherEbayCostCents],
    ["eBay shipping label", order.shippingLabelCents],
    ["Refunds / adjustments", order.refundCents],
  ];
  return (
    <span className="group relative inline-flex justify-end">
      <button type="button" className={cx("inline-flex items-center gap-1 font-bold tabular-nums text-slate-700 outline-none", !mobile && "font-medium")} aria-label={`Show cost breakdown for order ${order.ebayOrderId}`}>
        {formatCents(total)} <span className="text-[11px] text-indigo-500" aria-hidden>ⓘ</span>
      </button>
      <span role="tooltip" className={cx(
        "pointer-events-none invisible absolute z-30 w-64 rounded-xl border border-slate-200 bg-slate-950 p-3 text-left text-xs text-white opacity-0 shadow-2xl transition duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100",
        mobile ? "bottom-full left-1/2 mb-2 -translate-x-1/2" : "right-0 top-full mt-2",
      )}>
        <span className="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
          <span className="font-semibold">Cost breakdown</span>
          <span className={order.financialsActual ? "text-emerald-300" : "text-amber-300"}>{order.financialsActual ? "Actual eBay" : "Estimated eBay"}</span>
        </span>
        {rows.map(([label, amount]) => amount !== null && amount !== 0 && (
          <span key={label} className="flex justify-between gap-4 py-0.5 text-slate-300"><span>{label}</span><span className="tabular-nums text-white">{formatCents(amount)}</span></span>
        ))}
        <span className="mt-2 flex justify-between border-t border-white/10 pt-2 font-semibold"><span>Total costs</span><span className="tabular-nums">{formatCents(total)}</span></span>
        {order.profitCents !== null && <span className="mt-1 flex justify-between font-semibold"><span>Net profit</span><span className={order.profitCents >= 0 ? "text-emerald-300" : "text-red-300"}>{formatCents(order.profitCents)}</span></span>}
        <span className="mt-2 block text-[10px] leading-4 text-slate-400">Amazon: {order.costVerified ? "verified purchase total" : "estimated source cost"}.</span>
      </span>
    </span>
  );
}

export function OrdersView({ orders, fetchError, profitProtectionEnabled, autoRestockEnabled, sitewideDiscountBps, targetProfitEnabled, targetProfitDescription }: { orders: FulfillmentOrderRow[]; fetchError: string | null; profitProtectionEnabled: boolean; autoRestockEnabled: boolean; sitewideDiscountBps: number; targetProfitEnabled: boolean; targetProfitDescription: string }) {
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
  const [amazonOrderNumbers, setAmazonOrderNumbers] = useState<Record<string, string>>({});
  const [linkingOrderId, setLinkingOrderId] = useState<string | null>(null);
  const [amazonCostInputs, setAmazonCostInputs] = useState<Record<string, { item: string; shipping: string }>>({});
  const [savingAmazonCostOrderId, setSavingAmazonCostOrderId] = useState<string | null>(null);
  const [amazonPriceCheck, setAmazonPriceCheck] = useState<AmazonPriceCheckRun | null>(null);
  const displayOrders = useMemo(() => orders.map((order) => ({ ...order, ...orderOverrides[order.id] })), [orderOverrides, orders]);
  const trackingHelperOrders = useMemo(() => displayOrders.filter((order) =>
    !order.trackingNumber
    && !!order.amazonTrackingUrl
    && order.stage !== "CANCELLED"
    && order.stage !== "REFUNDED"
  ), [displayOrders]);
  const amazonPriceCheckOrders = useMemo(() => displayOrders.filter((order) =>
    order.stage === "AWAITING" && !!order.amazonUrl
  ), [displayOrders]);

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

  function linkKnownAmazonOrder(order: FulfillmentOrderRow) {
    const amazonOrderId = amazonOrderNumbers[order.id]?.trim() ?? "";
    setLinkingOrderId(order.id);
    startTransition(async () => {
      const result = await linkAmazonPurchase(order.id, amazonOrderId);
      setLinkingOrderId(null);
      if (result.error) {
        setRefreshMessage(result.error);
        return;
      }
      setRefreshMessage(`Amazon order ${result.amazonOrderId} linked to ${order.buyerUsername}.`);
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
        trackingTotal: Math.max(current.trackingTotal, current.trackingProcessed + 1),
        trackingProcessed: current.trackingProcessed + 1,
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
    function receiveAmazonPrice(event: Event) {
      const detail = (event as CustomEvent<{ orderIds?: string[]; unitPriceCents?: number; shippingCents?: number | null }>).detail;
      if (!detail?.orderIds?.length || !Number.isFinite(detail.unitPriceCents)) return;
      for (const orderId of detail.orderIds) {
        const order = displayOrders.find((candidate) => candidate.id === orderId);
        if (!order) continue;
        const itemCost = Math.round(detail.unitPriceCents! * Math.max(1, order.quantity));
        const shipping = detail.shippingCents === null || detail.shippingCents === undefined
          ? order.amazonShippingCents
          : Math.max(0, Math.round(detail.shippingCents));
        void persistAmazonCosts(order, itemCost, shipping, true);
      }
    }
    function receiveAmazonPriceProgress(event: Event) {
      const detail = (event as CustomEvent<{ status?: "running" | "complete"; total?: number; processed?: number; found?: number }>).detail;
      if (!detail?.status) return;
      setAmazonPriceCheck({
        status: detail.status,
        total: detail.total ?? 0,
        processed: detail.processed ?? 0,
        found: detail.found ?? 0,
      });
      if (detail.status === "complete") {
        setRefreshMessage(`Amazon price check complete: ${detail.found ?? 0} of ${detail.total ?? 0} unique product${detail.total === 1 ? "" : "s"} updated. Profit has been recalculated.`);
      }
    }
    document.addEventListener("sellfinity:tracking-filled", receiveExtensionTracking);
    document.addEventListener("sellfinity:tracking-helper-progress", receiveHelperProgress);
    document.addEventListener("sellfinity:amazon-price-found", receiveAmazonPrice);
    document.addEventListener("sellfinity:amazon-price-helper-progress", receiveAmazonPriceProgress);
    return () => {
      document.removeEventListener("sellfinity:tracking-filled", receiveExtensionTracking);
      document.removeEventListener("sellfinity:tracking-helper-progress", receiveHelperProgress);
      document.removeEventListener("sellfinity:amazon-price-found", receiveAmazonPrice);
      document.removeEventListener("sellfinity:amazon-price-helper-progress", receiveAmazonPriceProgress);
    };
  }, [displayOrders]);

  useEffect(() => {
    if (amazonPriceCheck?.status !== "starting") return;
    const timer = window.setTimeout(() => {
      setAmazonPriceCheck((current) => current?.status === "starting" ? { ...current, status: "unavailable" } : current);
      setRefreshMessage("The Amazon price checker needs Chrome helper version 1.3.1. Reload the helper, then refresh this Sellfinity tab and try again.");
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [amazonPriceCheck?.status]);

  useEffect(() => {
    if (refreshRun?.helper !== "starting") return;
    const timer = window.setTimeout(() => {
      setRefreshRun((current) => current?.helper === "starting"
        ? { ...current, helper: "complete", trackingTotal: 0, trackingProcessed: 0, trackingFound: 0 }
        : current);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [refreshRun?.helper]);

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
          setProtectionMessage("Protection is on. Refresh automatically protects eligible unlocked listings; individual buttons remain available for immediate updates.");
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

  function amazonCostInput(order: FulfillmentOrderRow) {
    return amazonCostInputs[order.id] ?? {
      item: ((order.amazonItemCostCents ?? 0) / 100).toFixed(2),
      shipping: (order.amazonShippingCents / 100).toFixed(2),
    };
  }

  function changeAmazonCost(order: FulfillmentOrderRow, field: "item" | "shipping", value: string) {
    setAmazonCostInputs((current) => ({
      ...current,
      [order.id]: { ...amazonCostInput(order), ...current[order.id], [field]: value },
    }));
  }

  async function persistAmazonCosts(order: FulfillmentOrderRow, itemCost: number, shipping: number, checkedFromAmazon = false) {
    setSavingAmazonCostOrderId(order.id);
    try {
      const result = await updateFulfillmentAmazonCosts(order.id, itemCost, shipping);
      if ("error" in result) {
        setRefreshMessage(result.error ?? "Could not save the Amazon costs.");
        return;
      }
      const landedCost = result.amazonItemCostCents + result.amazonShippingCents
        + order.amazonTaxCents - order.amazonDiscountCents;
      setAmazonCostInputs((current) => ({
        ...current,
        [order.id]: {
          item: (result.amazonItemCostCents / 100).toFixed(2),
          shipping: (result.amazonShippingCents / 100).toFixed(2),
        },
      }));
      setOrderOverrides((current) => ({
        ...current,
        [order.id]: {
          ...current[order.id],
          amazonItemCostCents: result.amazonItemCostCents,
          amazonShippingCents: result.amazonShippingCents,
          costCents: landedCost,
          costVerified: result.costVerified,
          profitCents: order.revenueCents - order.ebayFeeCents - landedCost,
        },
      }));
      if (!checkedFromAmazon) setRefreshMessage("Amazon item price and shipping saved. Profit was recalculated.");
    } catch {
      setRefreshMessage("Could not save the Amazon costs. Please try again.");
    } finally {
      setSavingAmazonCostOrderId((current) => current === order.id ? null : current);
    }
  }

  function saveAmazonCosts(order: FulfillmentOrderRow) {
    const values = amazonCostInput(order);
    const itemCost = Math.round(Number(values.item) * 100);
    const shipping = Math.round(Number(values.shipping) * 100);
    if (!Number.isFinite(itemCost) || !Number.isFinite(shipping) || itemCost < 0 || shipping < 0) {
      setRefreshMessage("Enter valid Amazon item and shipping amounts.");
      return;
    }
    void persistAmazonCosts(order, itemCost, shipping);
  }

  function checkAmazonPrices() {
    const grouped = new Map<string, { amazonUrl: string; orderIds: string[] }>();
    for (const order of amazonPriceCheckOrders) {
      const key = /^[A-Z0-9]{10}$/i.test(order.sku) ? order.sku.toUpperCase() : order.amazonUrl!;
      const current = grouped.get(key);
      if (current) current.orderIds.push(order.id);
      else grouped.set(key, {
        amazonUrl: /^[A-Z0-9]{10}$/i.test(order.sku) ? `https://www.amazon.com/dp/${order.sku}` : order.amazonUrl!,
        orderIds: [order.id],
      });
    }
    const requests = [...grouped.entries()].map(([requestKey, value]) => ({ requestKey, ...value }));
    if (!requests.length) {
      setRefreshMessage("There are no awaiting-purchase Amazon products to check.");
      return;
    }
    setAmazonPriceCheck({ status: "starting", total: requests.length, processed: 0, found: 0 });
    setRefreshMessage(`Opening ${requests.length} unique Amazon product${requests.length === 1 ? "" : "s"} in the signed-in price checker…`);
    document.dispatchEvent(new CustomEvent("sellfinity:bulk-amazon-price-check", { detail: { requests } }));
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
    const helperCandidates = trackingHelperOrders.length;
    const startedAt = Date.now();
    setRefreshElapsed(0);
    setRefreshRun({
      startedAt,
      server: "running",
      helper: helperCandidates ? "starting" : "complete",
      trackingTotal: 0,
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
    if (helperCandidates) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent("sellfinity:bulk-tracking-refresh"));
      }));
    }
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
        if (result.ebayImport?.financialsSynced) details.push(`${result.ebayImport.financialsSynced} finalized eBay earning${result.ebayImport.financialsSynced === 1 ? "" : "s"} refreshed`);
        if (result.ebayImport?.financialsWarning) details.push(result.ebayImport.financialsWarning);
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
          if (result.protection.deferred) details.push(`${result.protection.deferred} price check${result.protection.deferred === 1 ? " is" : "s are"} queued for the next refresh`);
          if (result.protection.winnerLocked) details.push(`${result.protection.winnerLocked} profitable listing price${result.protection.winnerLocked === 1 ? " was" : "s were"} preserved`);
          if (!result.protection.eligible && result.protection.checked) details.push(`${result.protection.checked} verified margin${result.protection.checked === 1 ? "" : "s"} checked`);
          if (result.protection.awaitingVerification) details.push(`${result.protection.awaitingVerification} price${result.protection.awaitingVerification === 1 ? " was" : "s were"} left unchanged because the Amazon cost is still estimated`);
        }
        if (result.restock.restocked) details.push(`${result.restock.restocked} listing${result.restock.restocked === 1 ? "" : "s"} refilled to 5`);
        if (result.restock.failed) details.push(`${result.restock.failed} stock refill${result.restock.failed === 1 ? "" : "s"} failed`);
        if (result.restockError) details.push("stock check unavailable");
        const helperRequests = result.trackingHelperRequests ?? [];
        if (helperRequests.length) {
          // The email scan may have discovered these URLs moments ago, after
          // the pre-refresh helper scan. Mirror them into the current rows so
          // both current and older helper versions can process them now.
          setOrderOverrides((current) => {
            const next = { ...current };
            for (const request of helperRequests) {
              next[request.orderId] = { ...next[request.orderId], amazonTrackingUrl: request.amazonUrl };
            }
            return next;
          });
          setTab("NEEDS_ACTION");
          setQuery("");
          setRefreshRun((current) => current ? {
            ...current,
            helper: "starting",
            trackingTotal: 0,
            trackingProcessed: 0,
            trackingFound: 0,
          } : current);
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            document.dispatchEvent(new CustomEvent("sellfinity:bulk-tracking-refresh", {
              detail: { requests: helperRequests },
            }));
          }));
          details.push(`${helperRequests.length} signed-in Amazon tracking check${helperRequests.length === 1 ? "" : "s"} started`);
        }
        setRefreshMessage(`Refresh complete: ${details.join(" · ")}.`);
        setRefreshRun((current) => current ? {
          ...current,
          server: "complete",
          result: `Refresh complete: ${details.join(" · ")}.`,
        } : current);
        router.refresh();
      } catch {
        const message = "Could not complete the Amazon and eBay refresh. Please try again.";
        setRefreshMessage(message);
        setRefreshRun((current) => current ? { ...current, server: "error", result: message } : current);
      }
    });
  }

  function cancelOrder(order: FulfillmentOrderRow) {
    if (!window.confirm(`Mark “${order.title}” as cancelled in Sellfinity? This does not cancel the order on eBay.`)) return;
    setCancellingOrderId(order.id);
    startTransition(async () => {
      try {
        const result = await markOrderCancelled(order.id);
        if (!("error" in result)) {
          setOrderOverrides((current) => ({ ...current, [order.id]: { stage: "CANCELLED" } }));
          router.refresh();
        }
      } finally {
        setCancellingOrderId(null);
      }
    });
  }

  const helperStartingTimedOut = refreshRun?.helper === "starting" && refreshElapsed >= 8;
  const refreshWorking = !!refreshRun && (
    refreshRun.server === "running" || refreshRun.helper === "running" || (refreshRun.helper === "starting" && !helperStartingTimedOut)
  );
  const amazonPriceCheckWorking = amazonPriceCheck?.status === "starting" || amazonPriceCheck?.status === "running";
  const refreshComplete = !!refreshRun && !refreshWorking && refreshRun.server === "complete";
  const refreshStatus = refreshWorking ? "running" : refreshComplete ? "complete" : "error";
  const helperRatio = refreshRun?.trackingTotal
    ? refreshRun.trackingProcessed / refreshRun.trackingTotal
    : 1;
  const refreshPercentage = !refreshRun
    ? 0
    : refreshComplete
      ? 100
      : refreshWorking
        ? Math.min(96, Math.max(8, refreshRun.server === "running" ? 12 + refreshElapsed * 0.8 : 60, 55 + helperRatio * 40))
        : 100;
  const refreshSubtitle = !refreshRun
    ? ""
    : refreshRun.server === "running"
      ? refreshElapsed < 8
        ? "Importing current eBay orders and preparing the Amazon email scan…"
        : refreshElapsed < 35
          ? "Scanning Amazon purchase, shipment, and delivery emails…"
          : refreshElapsed < 90
            ? "Resolving tracking links and matching purchases to fulfillment rows…"
            : "Still working normally—large email histories and Amazon tracking pages can take several minutes."
      : refreshRun.helper === "running"
        ? "Email and eBay refresh finished. The signed-in browser helper is still checking tracking pages."
        : refreshRun.result ?? "Refresh finished.";

  const needsActionOrders = useMemo(() => consolidatedNeedsActionOrders(displayOrders), [displayOrders]);
  const needsActionIds = useMemo(() => new Set(needsActionOrders.map((order) => order.id)), [needsActionOrders]);

  const tabCounts = useMemo(() => ({
    ALL: displayOrders.length,
    NEEDS_ACTION: needsActionOrders.length,
    PURCHASED: displayOrders.filter((order) => order.stage === "PURCHASED").length,
    IN_TRANSIT: displayOrders.filter((order) => order.stage === "IN_TRANSIT").length,
    DELIVERED: displayOrders.filter((order) => order.stage === "DELIVERED").length,
    EXCEPTIONS: displayOrders.filter((order) => tabMatches(order, "EXCEPTIONS")).length,
  }), [displayOrders, needsActionOrders]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return displayOrders
      .filter((order) => tab === "NEEDS_ACTION" ? needsActionIds.has(order.id) : tabMatches(order, tab))
      .filter((order) => !needle || [order.ebayOrderId, order.ebayListingId ?? "", order.title, order.buyerUsername, order.amazonOrderId ?? "", order.amazonTitle ?? "", order.trackingNumber ?? ""].some((value) => value.toLowerCase().includes(needle)))
      .sort((a, b) => {
        if (sort === "PROFIT") return (b.profitCents ?? -Infinity) - (a.profitCents ?? -Infinity);
        if (sort === "SHIP_BY") return (a.shipByDate ? new Date(a.shipByDate).getTime() : Infinity) - (b.shipByDate ? new Date(b.shipByDate).getTime() : Infinity);
        return new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime();
      });
  }, [displayOrders, needsActionIds, query, sort, tab]);

  const financialOrders = displayOrders.filter((order) => order.stage !== "CANCELLED" && order.stage !== "REFUNDED");
  const realizedProfit = financialOrders.filter((order) => order.costVerified && order.profitCents !== null).reduce((sum, order) => sum + (order.profitCents ?? 0), 0);
  const revenue = financialOrders.reduce((sum, order) => sum + order.revenueCents, 0);
  const delivered = displayOrders.filter((order) => order.stage === "DELIVERED").length;

  const tabs: { value: Tab; label: string }[] = [
    { value: "NEEDS_ACTION", label: "Needs action" },
    { value: "ALL", label: "All orders" },
    { value: "PURCHASED", label: "Awaiting Amazon shipment" },
    { value: "IN_TRANSIT", label: "Shipped orders" },
    { value: "DELIVERED", label: "Delivered" },
    { value: "EXCEPTIONS", label: "Exceptions" },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Needs action" value={tabCounts.NEEDS_ACTION.toLocaleString()} sub="Orders requiring your attention" tone={tabCounts.NEEDS_ACTION ? "negative" : "positive"} />
        <StatCard label="Shipped" value={tabCounts.IN_TRANSIT.toLocaleString()} sub="Tracking received and on the way" />
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
            <p className="mt-1.5 text-sm leading-6 text-slate-600">When Refresh verifies that an order missed {targetProfitEnabled ? `your ${targetProfitDescription} per item` : "the standard 5% / $7 profit safeguard"}, Sellfinity raises the active eBay listing for future orders. Listings locked after a profitable sale and Verified Winners keep their protected price unless you confirm a change; the lock releases after seven days without a profitable sale. Estimated costs never trigger a price change, and affected rows show the updated future price.{sitewideDiscountBps > 0 ? ` Prices are grossed up for your ${(sitewideDiscountBps / 100).toFixed(2).replace(/\.00$/, "")}% sitewide eBay discount.` : ""}</p>
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

        <div className="grid gap-2 border-b border-slate-200 p-3 sm:flex sm:flex-wrap sm:items-center sm:p-4">
          <div className="min-w-[260px] flex-1"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search order, buyer, item, Amazon order, or tracking…" aria-label="Search fulfillment orders" /></div>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700" aria-label="Sort orders">
            <option value="NEWEST">Newest first</option><option value="SHIP_BY">Ship-by date</option><option value="PROFIT">Highest profit</option>
          </select>
          <Button data-sellfinity-refresh="true" variant="secondary" disabled={refreshWorking} onClick={refreshFulfillment}>{refreshWorking ? "Refresh in progress…" : "↻ Refresh Amazon & eBay"}</Button>
          <Button variant="secondary" disabled={amazonPriceCheckWorking || refreshWorking} onClick={checkAmazonPrices}>{amazonPriceCheckWorking ? `Checking ${amazonPriceCheck?.processed ?? 0}/${amazonPriceCheck?.total ?? 0}…` : "Check Amazon prices"}</Button>
          <a href="/downloads/sellfinity-tracking-helper.zip?v=1.3.1" download className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Download Chrome helper v1.3.1</a>
        </div>

        {amazonPriceCheck && amazonPriceCheck.status !== "unavailable" && (
          <div className="border-b border-violet-100 bg-violet-50/70 px-4 py-3" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs font-medium text-violet-900">
              <span>{amazonPriceCheck.status === "complete" ? "Amazon prices checked" : "Checking signed-in Amazon prices and shipping…"}</span>
              <span>{amazonPriceCheck.processed}/{amazonPriceCheck.total} · {amazonPriceCheck.found} updated</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-violet-100">
              <div className="h-full rounded-full bg-violet-600 transition-all duration-500" style={{ width: `${amazonPriceCheck.total ? Math.max(5, amazonPriceCheck.processed / amazonPriceCheck.total * 100) : 5}%` }} />
            </div>
          </div>
        )}

        {refreshRun ? (
          <div className="border-b border-slate-200 bg-slate-50/70 p-4" role="status" aria-live="polite">
            <PremiumProgress
              title={refreshWorking ? "Refreshing fulfillment" : refreshComplete ? "Fulfillment refresh complete" : "Fulfillment refresh needs attention"}
              subtitle={refreshSubtitle}
              percentage={refreshPercentage}
              status={refreshStatus}
              stats={[
                { label: "elapsed", value: elapsedLabel(refreshElapsed), tone: "info" },
                ...(refreshRun.trackingTotal > 0 && (refreshRun.helper === "running" || refreshRun.helper === "complete") ? [
                  { label: "tracking links checked", value: `${refreshRun.trackingProcessed}/${refreshRun.trackingTotal}` },
                  { label: "tracking IDs found", value: refreshRun.trackingFound, tone: refreshRun.trackingFound ? "success" as const : "default" as const },
                ] : []),
              ]}
              className="border-0 shadow-none"
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "eBay orders", active: refreshRun.server === "running" && refreshElapsed < 8, done: refreshRun.server !== "running" },
                { label: "Amazon emails", active: refreshRun.server === "running" && refreshElapsed >= 8, done: refreshRun.server !== "running" },
                ...(refreshRun.helper === "running" || (refreshRun.helper === "complete" && refreshRun.trackingTotal > 0) ? [{ label: "Tracking pages", active: refreshRun.helper === "running", done: refreshRun.helper === "complete" }] : []),
                { label: "Prices & stock", active: refreshRun.server === "running" && refreshElapsed >= 35, done: refreshRun.server === "complete" },
              ].map((stage) => (
                <div key={stage.label} className={cx("flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors", stage.done ? "border-emerald-200 bg-emerald-50 text-emerald-700" : stage.active ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-400")}>
                  <span className={cx("flex h-5 w-5 items-center justify-center rounded-full", stage.done ? "bg-emerald-600 text-white" : stage.active ? "animate-pulse bg-indigo-600 text-white" : "bg-slate-200 text-slate-500")}>{stage.done ? "✓" : stage.active ? "•" : ""}</span>
                  {stage.label}
                </div>
              ))}
            </div>
          </div>
        ) : refreshMessage && <p className="border-b border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800" role="status">{refreshMessage}</p>}

        {fetchError && <p className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Live status is temporarily unavailable: {fetchError}</p>}
        {tab === "NEEDS_ACTION" && (
          <p className="border-b border-sky-100 bg-sky-50/70 px-4 py-2.5 text-xs leading-5 text-sky-900">
            Shipped or delivered orders appear here only when you can still resolve tracking or the listing&apos;s future price needs attention. Temporary eBay errors on delivered orders retry automatically under Exceptions.
          </p>
        )}

        {/* Keep this before the visual mobile/desktop rows. Installed helper
         * versions use the first matching field when they auto-save, so this
         * stable hidden row also works when an order is outside the filter. */}
        <table className="hidden" aria-hidden="true">
          <tbody>
            {trackingHelperOrders.map((order) => (
              <tr key={`tracking-helper-${order.id}`}>
                <td><a href={order.amazonTrackingUrl!}>Open Amazon tracking</a></td>
                <td>
                  <input
                    data-order-id={order.id}
                    value={manualTracking[order.id] ?? ""}
                    onChange={(event) => setManualTracking((current) => ({ ...current, [order.id]: event.target.value }))}
                    aria-label={`Tracking number for ${order.ebayOrderId}`}
                  />
                  <button type="button" onClick={() => submitTracking(order)}>Save tracking</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="hidden" aria-hidden="true">
          {amazonPriceCheckOrders.map((order) => (
            <a
              key={`amazon-price-helper-${order.id}`}
              data-amazon-price-check="true"
              data-order-id={order.id}
              data-request-key={/^[A-Z0-9]{10}$/i.test(order.sku) ? order.sku.toUpperCase() : order.amazonUrl!}
              href={/^[A-Z0-9]{10}$/i.test(order.sku) ? `https://www.amazon.com/dp/${order.sku}` : order.amazonUrl!}
            >Check Amazon price</a>
          ))}
        </div>

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
                    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-1.5"><Badge tone={meta.tone}>{meta.label}</Badge>{tab === "NEEDS_ACTION" && actionReasonLabel(order) && <Badge tone="slate">{actionReasonLabel(order)}</Badge>}{order.verifiedWinner && <Badge tone="amber">🏆 Winner</Badge>}{!order.verifiedWinner && order.priceLocked && <Badge tone="indigo">🔒 Price locked</Badge>}</div><span className="text-[11px] text-slate-400">#{order.ebayOrderId}</span></div>
                    <p className="mt-2 line-clamp-2 text-[13px] font-semibold leading-5 text-slate-950">{order.title}</p>
                    <p className="mt-1 text-xs text-slate-500">{order.buyerUsername} · Qty {order.quantity}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 rounded-xl bg-slate-50 p-3 text-center">
                  <div><p className="text-[10px] uppercase text-slate-400">Revenue</p><p className="mt-1 text-sm font-bold">{formatCents(order.revenueCents)}</p></div>
                  <div className="border-x border-slate-200"><p className="text-[10px] uppercase text-slate-400">Cost</p><p className="mt-1 text-sm"><CostBreakdown order={order} mobile /></p></div>
                  <div><p className="text-[10px] uppercase text-slate-400">Profit</p><p className={cx("mt-1 text-sm font-bold", order.profitCents === null ? "text-slate-400" : order.profitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{order.profitCents === null ? "—" : formatCents(order.profitCents)}</p></div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-3">
                  <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Amazon price
                    <span className="mt-1 flex items-center rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-900 focus-within:border-indigo-500"><span className="text-slate-400">$</span><input inputMode="decimal" value={amazonCostInput(order).item} onChange={(event) => changeAmazonCost(order, "item", event.target.value)} className="min-w-0 flex-1 bg-transparent px-1 py-2 outline-none" aria-label={`Amazon item price for ${order.ebayOrderId}`} /></span>
                  </label>
                  <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Amazon shipping
                    <span className="mt-1 flex items-center rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-900 focus-within:border-indigo-500"><span className="text-slate-400">$</span><input inputMode="decimal" value={amazonCostInput(order).shipping} onChange={(event) => changeAmazonCost(order, "shipping", event.target.value)} className="min-w-0 flex-1 bg-transparent px-1 py-2 outline-none" aria-label={`Amazon shipping for ${order.ebayOrderId}`} /></span>
                  </label>
                  <Button size="sm" variant="secondary" className="col-span-2" disabled={savingAmazonCostOrderId === order.id} onClick={() => saveAmazonCosts(order)}>{savingAmazonCostOrderId === order.id ? "Saving costs…" : "Save Amazon costs"}</Button>
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
                {(protectionFailed || protectionReview) && (
                  <details className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-700">View price-protection error</summary>
                    <p className="mt-2 text-xs leading-5 text-slate-600">{protectionErrorSummary(order.profitProtectionError)}</p>
                  </details>
                )}
                <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                  <span className={overdue ? "font-semibold text-red-600" : "text-slate-500"}>{order.shipByDate ? `Ship by ${displayDate(order.shipByDate)}` : displayDate(order.saleDate)}</span>
                  {order.stage === "AWAITING" && order.amazonUrl
                    ? <a href={order.amazonUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-xl bg-indigo-600 px-3 font-semibold text-white">Buy on Amazon</a>
                    : protectionReview
                      ? <a href="/listings" className="inline-flex min-h-10 items-center rounded-xl border border-amber-200 bg-amber-50 px-3 font-semibold text-amber-800">Review listing</a>
                      : protectionFailed || (order.suggestedProtectedPriceCents !== null && (order.verifiedWinner || order.priceLocked))
                        ? <Button size="sm" variant={protectionFailed ? "secondary" : "primary"} disabled={pending} onClick={() => protectOneOrder(order.id)}>{retryingOrderId === order.id ? "Contacting eBay…" : protectionFailed ? "Retry protection" : `Confirm ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}`}</Button>
                        : order.suggestedProtectedPriceCents !== null
                          ? <Button size="sm" disabled={pending} onClick={() => protectOneOrder(order.id)}>Protect at {formatCents(order.suggestedProtectedPriceCents)}</Button>
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
                {order.stage === "AWAITING" && !order.amazonOrderId && (
                  <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-700">Already purchased on Amazon?</summary>
                    <p className="mt-2 text-[11px] leading-4 text-slate-500">Link the confirmation only when automatic matching needs help.</p>
                    <div className="mt-2 grid gap-2">
                      <Input value={amazonOrderNumbers[order.id] ?? ""} onChange={(event) => setAmazonOrderNumbers((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="123-1234567-1234567" aria-label={`Amazon order number for ${order.ebayOrderId}`} />
                      <Button size="sm" variant="secondary" disabled={pending || linkingOrderId === order.id} onClick={() => linkKnownAmazonOrder(order)}>{linkingOrderId === order.id ? "Validating…" : "Link purchase"}</Button>
                    </div>
                  </details>
                )}
              </article>
            );
          })}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1540px] text-sm">
            <thead className="bg-white text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr><th className="px-5 py-3">Order</th><th className="px-4 py-3">Item &amp; buyer</th><th className="px-4 py-3">Fulfillment</th><th className="px-4 py-3">Tracking</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3">Amazon price</th><th className="px-4 py-3">Amazon shipping</th><th className="px-4 py-3 text-right">Total costs</th><th className="px-4 py-3 text-right">Profit</th><th className="px-4 py-3">Next step</th></tr>
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
                    <td className="px-4 py-4"><Badge tone={meta.tone}>{meta.label}</Badge>{tab === "NEEDS_ACTION" && actionReasonLabel(order) && <div className="mt-1.5"><Badge tone="slate">{actionReasonLabel(order)}</Badge></div>}{order.amazonOrderId && <p className="mt-2 text-xs text-slate-500">Amazon #{order.amazonOrderId}</p>}{order.matchConfidence !== null && <p className="mt-0.5 text-[11px] text-slate-400">{order.matchConfidence}% source match</p>}{order.amazonOrderId && duplicateAwaitingOrders(order).length > 0 && <details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold text-amber-700">Correct match</summary><div className="mt-1.5 grid gap-1">{duplicateAwaitingOrders(order).map((target) => <button key={target.id} type="button" disabled={pending || reassigningOrderId === order.id} onClick={() => moveAmazonMatch(order, target)} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-left text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50">{reassigningOrderId === order.id ? "Moving…" : `Move to ${target.buyerUsername}`}</button>)}</div></details>}{order.stage === "AWAITING" && !order.amazonOrderId && <details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold text-slate-600">Already purchased?</summary><div className="mt-1.5 grid gap-1.5"><input value={amazonOrderNumbers[order.id] ?? ""} onChange={(event) => setAmazonOrderNumbers((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="Amazon order number" aria-label={`Amazon order number for ${order.ebayOrderId}`} className="w-44 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none" /><Button size="sm" variant="secondary" disabled={pending || linkingOrderId === order.id} onClick={() => linkKnownAmazonOrder(order)}>{linkingOrderId === order.id ? "Validating…" : "Link purchase"}</Button></div></details>}</td>
                    <td className="max-w-[240px] px-4 py-4">{order.trackingNumber ? <><a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="break-all font-medium text-indigo-700 hover:underline">{order.trackingNumber}</a><p className="mt-1 text-xs text-slate-500">{order.carrier ?? "Carrier pending"}{order.trackingSynced ? " · sent to eBay" : order.stage === "DELIVERED" ? " · saved" : " · waiting for eBay"}</p></> : <>{order.amazonTrackingUrl ? <><a href={order.amazonTrackingUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 hover:underline">Open Amazon tracking ↗</a><p className="mt-1 text-xs text-amber-700">Tracking number pending</p></> : <span className="text-slate-400">Not available yet</span>}{order.stage !== "CANCELLED" && order.stage !== "REFUNDED" && <div className="mt-2 space-y-1.5"><input data-order-id={order.id} value={manualTracking[order.id] ?? ""} onChange={(event) => setManualTracking((current) => ({ ...current, [order.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") submitTracking(order, event.currentTarget.value); }} placeholder="Enter tracking number" aria-label={`Tracking number for ${order.ebayOrderId}`} className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none" /><Button size="sm" variant="secondary" disabled={pending || savingTrackingOrderId === order.id} onClick={() => submitTracking(order)} className="w-full">{savingTrackingOrderId === order.id ? "Saving…" : order.stage === "DELIVERED" ? "Save tracking" : "Save & mark shipped"}</Button></div>}</>}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-right"><p className="font-semibold tabular-nums text-slate-900">{formatCents(order.revenueCents)}</p><p className="mt-1 text-[11px] text-slate-400">eBay sale</p></td>
                    <td className="w-32 px-4 py-4"><span className="flex items-center rounded-md border border-slate-300 bg-white px-2 text-sm focus-within:border-indigo-500"><span className="text-slate-400">$</span><input inputMode="decimal" value={amazonCostInput(order).item} onChange={(event) => changeAmazonCost(order, "item", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveAmazonCosts(order); }} className="w-20 bg-transparent px-1 py-1.5 tabular-nums outline-none" aria-label={`Amazon item price for ${order.ebayOrderId}`} /></span>{order.quantity > 1 && <p className="mt-1 text-[10px] text-slate-400">Total for qty {order.quantity}</p>}</td>
                    <td className="w-32 px-4 py-4"><span className="flex items-center rounded-md border border-slate-300 bg-white px-2 text-sm focus-within:border-indigo-500"><span className="text-slate-400">$</span><input inputMode="decimal" value={amazonCostInput(order).shipping} onChange={(event) => changeAmazonCost(order, "shipping", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveAmazonCosts(order); }} className="w-20 bg-transparent px-1 py-1.5 tabular-nums outline-none" aria-label={`Amazon shipping for ${order.ebayOrderId}`} /></span><button type="button" disabled={savingAmazonCostOrderId === order.id} onClick={() => saveAmazonCosts(order)} className="mt-1 text-[11px] font-semibold text-indigo-700 disabled:text-slate-400">{savingAmazonCostOrderId === order.id ? "Saving…" : "Save costs"}</button></td>
                    <td className="whitespace-nowrap px-4 py-4 text-right"><CostBreakdown order={order} /><p className="mt-1 text-[11px] text-slate-400">{order.costVerified ? "Verified Amazon" : "Estimated Amazon"} · {order.financialsActual ? "actual eBay" : "estimated eBay"}</p></td>
                    <td className="whitespace-nowrap px-4 py-4 text-right">
                      <p className={cx("font-semibold tabular-nums", order.profitCents === null ? "text-slate-400" : order.profitCents >= 0 ? "text-emerald-700" : "text-red-600")}>{order.profitCents === null ? "—" : formatCents(order.profitCents)}</p>
                      {order.profitProtectionStatus === "ADJUSTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Future listing {formatCents(order.profitProtectionNewPriceCents)} · updated</p>}
                      {order.profitProtectionStatus === "RELISTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Relisted at {formatCents(order.profitProtectionNewPriceCents)}</p>}
                      {order.profitProtectionStatus === "ALREADY_PROTECTED" && order.profitProtectionNewPriceCents !== null && <p className="mt-1 text-[11px] font-medium text-emerald-700">Future listing {formatCents(order.profitProtectionNewPriceCents)} · protected</p>}
                      {order.profitProtectionStatus === null && order.suggestedProtectedPriceCents !== null && <p className={cx("mt-1 text-[11px] font-medium", order.verifiedWinner || order.priceLocked ? "text-amber-700" : "text-indigo-700")}>{order.verifiedWinner || order.priceLocked ? "Price locked · suggested" : "Planned future price"} {formatCents(order.suggestedProtectedPriceCents)}</p>}
                      {(protectionReview || protectionFailed) && order.profitProtectionNewPriceCents !== null && <p className={cx("mt-1 text-[11px] font-medium", protectionFailed ? "text-red-700" : "text-amber-700")}>Target future price {formatCents(order.profitProtectionNewPriceCents)}</p>}
                      {(protectionReview || protectionFailed) && <><p className={cx("mt-1 max-w-[180px] whitespace-normal text-[11px]", protectionFailed ? "text-red-600" : "text-amber-700")}>{protectionFailed ? "Price update failed" : "Listing review needed"}</p><details className="mt-1 max-w-[200px] text-left"><summary className="cursor-pointer text-[11px] font-medium text-slate-600">View error</summary><p className="mt-1 whitespace-normal text-[11px] leading-4 text-slate-500">{protectionErrorSummary(order.profitProtectionError)}</p></details></>}
                      {awaitingVerifiedCost && <p className="mt-1 max-w-[190px] whitespace-normal text-[11px] font-medium leading-4 text-amber-700">{priceChangedSinceSale ? `Current price ${formatCents(order.listingPriceCents!)} · sale price ${formatCents(order.soldUnitPriceCents)}` : "Price unchanged · awaiting verified cost"}</p>}
                    </td>
                    <td className="px-4 py-4">
                      {order.stage === "AWAITING" ? order.amazonUrl ? <a href={order.amazonUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">Buy on Amazon ↗</a> : <a href="/listings" className="inline-flex rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">Find source</a> : protectionReview ? <a href="/listings" className="inline-flex rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Review listing</a> : protectionFailed || (order.suggestedProtectedPriceCents !== null && (order.verifiedWinner || order.priceLocked)) ? <Button size="sm" variant={protectionFailed ? "secondary" : "primary"} disabled={pending} onClick={() => protectOneOrder(order.id)}>{retryingOrderId === order.id ? "Contacting eBay…" : protectionFailed ? "Retry protection" : `Confirm ${formatCents(order.suggestedProtectedPriceCents ?? order.profitProtectionNewPriceCents ?? 0)}`}</Button> : order.suggestedProtectedPriceCents !== null ? <Button size="sm" disabled={pending} onClick={() => protectOneOrder(order.id)}>Protect at {formatCents(order.suggestedProtectedPriceCents)}</Button> : order.trackingNumber ? <a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Track package ↗</a> : <span className="text-xs text-slate-400">No action needed</span>}
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
