import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { ebayAdvertisingFeeCents, ebayFeeCents as estimatedEbayTransactionFeeCents } from "@/lib/fees";
import { parseImageUrls } from "@/lib/types";
import { Badge, PageHeader } from "@/components/ui";
import { OrdersView, type FulfillmentOrderRow } from "./orders-view";
import { actualAmazonCost } from "@/lib/amazon-email/sync";
import { verifiedProfitProtectionDecision } from "@/lib/orders/profit-protection-policy";
import { remoteFulfillmentLookupKeys } from "@/lib/amazon-email/tracking-utils";
import { fulfillmentStage } from "@/lib/orders/fulfillment-stage";
import { getListingPriceProtection } from "@/lib/listings/winner";
import { orderProfitBreakdown } from "@/lib/orders/profit";
import type { EbayFeeBreakdownEntry } from "@/lib/ebay/order-financials";
import { resolveTargetProfitCents, targetProfitLabel } from "@/lib/listings/target-profit";

export const metadata = { title: "Fulfillment — Sellfinity" };
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function feeDetails(value: string): EbayFeeBreakdownEntry[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is EbayFeeBreakdownEntry => Boolean(
      entry && typeof entry === "object"
      && typeof (entry as EbayFeeBreakdownEntry).type === "string"
      && Number.isFinite((entry as EbayFeeBreakdownEntry).amountCents),
    ));
  } catch { return []; }
}

export default async function OrdersPage() {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  const ebayConnected = !!connection && connection.status !== "DISCONNECTED";
  const storedOrders = await db.order.findMany({
    where: { userId: user.id },
    include: {
      listing: { include: { product: true } },
      amazonPurchaseItem: { include: { purchase: true } },
    },
    orderBy: { saleDate: "desc" },
  });
  const priceProtection = await getListingPriceProtection(user.id, user.ebayAdRateBps);
  const winnerListings = priceProtection.verifiedWinners;
  const profitableSaleLocks = priceProtection.profitableSaleLocks;

  let fetchError: string | null = null;
  let liveOrders: Awaited<ReturnType<Awaited<ReturnType<typeof getEbayClientForUser>>["getUnfulfilledOrders"]>> = [];
  if (ebayConnected) {
    try {
      const client = await getEbayClientForUser(user.id);
      liveOrders = await client.getUnfulfilledOrders(user.id);
    } catch (error) {
      fetchError = error instanceof Error ? error.message.slice(0, 300) : "eBay lookup failed";
    }
  }

  const liveLineByImportedId: Map<string, {
    order: (typeof liveOrders)[number];
    line: (typeof liveOrders)[number]["lines"][number];
  }> = new Map(
    liveOrders.flatMap((order) =>
      order.lines.flatMap((line) =>
        remoteFulfillmentLookupKeys(order.orderId, line.lineItemId, order.lines.length)
          .map((key) => [key, { order, line }] as const),
      ),
    ),
  );
  const rows: FulfillmentOrderRow[] = storedOrders.map((order) => {
    const live = liveLineByImportedId.get(order.ebayOrderId);
    const purchaseItem = order.amazonPurchaseItem;
    const purchase = purchaseItem?.purchase;
    const verifiedCostCents = purchaseItem ? actualAmazonCost(purchaseItem) : null;
    const breakdown = orderProfitBreakdown({
      ...order,
      actualAmazonCostCents: verifiedCostCents,
    }, user.ebayAdRateBps);
    const stage = fulfillmentStage({
      ebayStatus: order.status,
      sourcingStatus: order.sourcingStatus,
      amazonPurchaseStatus: purchase?.status,
      hasShipmentDetails: Boolean(
        order.ebayTrackingNumber || purchase?.trackingNumber || purchase?.trackingUrl,
      ),
    });
    const protectionDecision = verifiedCostCents === null ? null : verifiedProfitProtectionDecision({
      currentListingPriceCents: order.listing.priceCents,
      orderQuantity: order.quantity,
      realizedRevenueCents: breakdown.revenueCents,
      realizedEbayFeeCents: breakdown.transactionFeeCents
        + breakdown.otherEbayCostCents
        + breakdown.shippingLabelCents
        + breakdown.refundCents,
      realizedAdvertisingFeeCents: breakdown.actualEbayFinancials
        ? breakdown.advertisingFeeCents
        : undefined,
      verifiedAmazonCostCents: verifiedCostCents,
      sitewideDiscountBps: user.ebaySitewideDiscountBps,
      adRateBps: user.ebayAdRateBps,
      targetProfitCents: resolveTargetProfitCents(user, {
        amazonCostCents: Math.ceil(verifiedCostCents / Math.max(1, order.quantity)),
        currentEbayPriceCents: order.listing.priceCents,
      }),
    });
    return {
      id: order.id,
      ebayOrderId: order.ebayOrderId,
      ebayListingId: order.listing.ebayListingId,
      ebayUrl: order.listing.ebayListingId
        ? `${ebayEnvConfig()?.env === "PRODUCTION" ? "https://www.ebay.com" : "https://sandbox.ebay.com"}/itm/${order.listing.ebayListingId}`
        : null,
      title: order.listing.title,
      sku: order.listing.product.sku,
      imageUrl: parseImageUrls(order.listing.imageUrlsJson)[0] ?? null,
      buyerUsername: order.buyerUsername,
      saleDate: order.saleDate.toISOString(),
      quantity: order.quantity,
      stage,
      shipByDate: live?.line.shipByDate?.toISOString() ?? null,
      variation: live?.line.variation ?? null,
      amazonTitle: purchaseItem?.title ?? order.listing.product.title,
      amazonOrderId: purchase?.amazonOrderId ?? null,
      amazonUrl: purchaseItem?.amazonUrl ?? order.listing.product.supplierUrl,
      trackingNumber: order.ebayTrackingNumber ?? purchase?.trackingNumber ?? null,
      carrier: order.ebayTrackingCarrier ?? purchase?.carrier ?? null,
      amazonTrackingUrl: purchase?.trackingUrl ?? null,
      trackingLookupError: purchase?.trackingLookupError ?? null,
      trackingSynced: !!order.ebayTrackingSyncedAt,
      trackingError: order.ebayTrackingSyncError,
      ebayFulfilled: order.status === "SHIPPED",
      revenueCents: breakdown.revenueCents,
      soldUnitPriceCents: order.salePriceCents,
      listingPriceCents: order.listing.priceCents,
      ebayFeeCents: breakdown.totalCostCents - breakdown.amazonCostCents,
      transactionFeeCents: breakdown.transactionFeeCents,
      advertisingFeeCents: breakdown.advertisingFeeCents,
      otherEbayCostCents: breakdown.otherEbayCostCents,
      shippingLabelCents: breakdown.shippingLabelCents,
      refundCents: breakdown.refundCents,
      amazonItemCostCents: purchaseItem?.lineTotalCents ?? order.cogsCents,
      amazonShippingCents: purchaseItem?.allocatedShippingCents ?? order.shippingCostCents,
      amazonTaxCents: purchaseItem?.allocatedTaxCents ?? 0,
      amazonDiscountCents: purchaseItem?.allocatedDiscountCents ?? 0,
      financialsActual: breakdown.actualEbayFinancials,
      ebayFeeDetails: breakdown.actualEbayFinancials ? feeDetails(order.ebayFeeBreakdownJson) : [],
      costCents: breakdown.amazonCostCents,
      costVerified: verifiedCostCents !== null,
      profitCents: breakdown.profitCents,
      matchConfidence: purchaseItem?.matchConfidence ?? null,
      needsSource: !purchaseItem && !order.listing.product.supplierUrl,
      profitProtectionStatus: order.profitProtectionStatus,
      profitProtectionNewPriceCents: order.profitProtectionNewPriceCents,
      profitProtectionError: order.profitProtectionError,
      suggestedProtectedPriceCents: protectionDecision?.action === "reprice" ? protectionDecision.targetPriceCents : null,
      verifiedWinner: winnerListings.has(order.listingId),
      priceLocked: !winnerListings.has(order.listingId) && profitableSaleLocks.has(order.listingId),
      winnerProtectedUntil: winnerListings.get(order.listingId)?.protectedUntil?.toISOString() ?? null,
    };
  });

  // A newly paid eBay order can appear before the scheduled importer stores it.
  const storedIds = new Set(storedOrders.map((order) => order.ebayOrderId));
  const missingLiveLines = liveOrders.flatMap((order) =>
    order.lines.filter((line) =>
      !remoteFulfillmentLookupKeys(order.orderId, line.lineItemId, order.lines.length)
        .some((key) => storedIds.has(key)),
    ).map((line) => ({ order, line })),
  );
  if (missingLiveLines.length) {
    const listingIds = [...new Set(missingLiveLines.map(({ line }) => line.ebayListingId))];
    const listings = await db.listing.findMany({
      where: { userId: user.id, ebayListingId: { in: listingIds } },
      include: { product: true },
    });
    const byEbayId = new Map(listings.map((listing) => [listing.ebayListingId, listing]));
    for (const { order, line } of missingLiveLines) {
      const listing = byEbayId.get(line.ebayListingId);
      const revenueCents = line.salePriceCents * line.quantity + line.shippingChargedCents;
      const estimatedTransactionFee = estimatedEbayTransactionFeeCents({
        quantity: line.quantity,
        salePriceCents: line.salePriceCents,
        shippingChargedCents: line.shippingChargedCents,
      });
      const estimatedAdvertisingFee = ebayAdvertisingFeeCents(revenueCents, user.ebayAdRateBps);
      const estimatedAmazonCost = listing
        ? (listing.product.costCents + listing.product.shippingCostCents) * line.quantity
        : null;
      rows.push({
        id: `${order.orderId}-${line.lineItemId}`,
        ebayOrderId: order.orderId,
        ebayListingId: line.ebayListingId,
        ebayUrl: `${ebayEnvConfig()?.env === "PRODUCTION" ? "https://www.ebay.com" : "https://sandbox.ebay.com"}/itm/${line.ebayListingId}`,
        title: line.title,
        sku: listing?.product.sku ?? "",
        imageUrl: listing ? parseImageUrls(listing.imageUrlsJson)[0] ?? null : null,
        buyerUsername: order.buyerUsername,
        saleDate: order.createdAt.toISOString(),
        quantity: line.quantity,
        stage: line.fulfillmentStatus === "IN_PROGRESS" ? "PURCHASED" : "AWAITING",
        shipByDate: line.shipByDate?.toISOString() ?? null,
        variation: line.variation,
        amazonTitle: listing?.product.title ?? null,
        amazonOrderId: null,
        amazonUrl: listing?.product.supplierUrl ?? null,
        trackingNumber: null,
        carrier: null,
        amazonTrackingUrl: null,
        trackingLookupError: null,
        trackingSynced: false,
        trackingError: null,
        ebayFulfilled: false,
        revenueCents,
        soldUnitPriceCents: line.salePriceCents,
        listingPriceCents: listing?.priceCents ?? null,
        ebayFeeCents: estimatedTransactionFee + estimatedAdvertisingFee,
        transactionFeeCents: estimatedTransactionFee,
        advertisingFeeCents: estimatedAdvertisingFee,
        otherEbayCostCents: 0,
        shippingLabelCents: 0,
        refundCents: 0,
        amazonItemCostCents: listing ? listing.product.costCents * line.quantity : null,
        amazonShippingCents: listing ? listing.product.shippingCostCents * line.quantity : 0,
        amazonTaxCents: 0,
        amazonDiscountCents: 0,
        financialsActual: false,
        ebayFeeDetails: [],
        costCents: estimatedAmazonCost,
        costVerified: false,
        profitCents: estimatedAmazonCost === null ? null : revenueCents - estimatedTransactionFee - estimatedAdvertisingFee - estimatedAmazonCost,
        matchConfidence: null,
        needsSource: !listing,
        profitProtectionStatus: null,
        profitProtectionNewPriceCents: null,
        profitProtectionError: null,
        suggestedProtectedPriceCents: null,
        verifiedWinner: listing ? winnerListings.has(listing.id) : false,
        priceLocked: listing ? !winnerListings.has(listing.id) && profitableSaleLocks.has(listing.id) : false,
        winnerProtectedUntil: listing ? winnerListings.get(listing.id)?.protectedUntil?.toISOString() ?? null : null,
      });
    }
  }

  rows.sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime());

  return (
    <>
      <PageHeader
        title="Fulfillment"
        subtitle="Every eBay order in one place—from purchase and tracking through delivery and realized profit."
        actions={<Badge tone={ebayConnected ? "green" : "amber"}>{ebayConnected ? "Live eBay status" : "eBay not connected"}</Badge>}
      />
      <div className="relative left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 md:w-[calc(100vw-17rem)]">
        <OrdersView
          orders={rows}
          fetchError={fetchError ?? (!ebayConnected ? "Connect eBay in Settings to refresh open orders." : null)}
          profitProtectionEnabled={user.autoProtectVerifiedProfit}
          autoRestockEnabled={user.autoRestockFulfilledListings}
          sitewideDiscountBps={user.ebaySitewideDiscountBps}
          targetProfitEnabled={user.targetProfitEnabled}
          targetProfitDescription={targetProfitLabel(user)}
        />
      </div>
    </>
  );
}
