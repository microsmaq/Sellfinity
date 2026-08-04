import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { estimateMargin } from "@/lib/fees";
import { parseImageUrls } from "@/lib/types";
import { Badge, PageHeader } from "@/components/ui";
import { OrdersView, type FulfillmentOrderRow } from "./orders-view";
import { actualAmazonCost } from "@/lib/amazon-email/sync";

export const metadata = { title: "Orders to fulfill — Sellfinity" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function OrdersPage() {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  const ebayConnected = !!connection && connection.status !== "DISCONNECTED";
  let rows: FulfillmentOrderRow[] = [];
  let fetchError: string | null = null;
  const purchaseHistory = await db.order.findMany({
    where: { userId: user.id, amazonPurchaseItem: { isNot: null } },
    include: { listing: { include: { product: true } }, amazonPurchaseItem: { include: { purchase: true } } },
    orderBy: { amazonMatchedAt: "desc" },
    take: 200,
  });
  const amazonPurchases = await db.amazonPurchase.findMany({
    where: { userId: user.id }, include: { items: true }, orderBy: [{ purchasedAt: "desc" }, { createdAt: "desc" }], take: 200,
  });

  if (ebayConnected) {
    try {
      const client = await getEbayClientForUser(user.id);
      const orders = await client.getUnfulfilledOrders(user.id);
      const ebayIds = [...new Set(orders.flatMap((order) => order.lines.map((line) => line.ebayListingId)))];
      const listings = await db.listing.findMany({
        where: { userId: user.id, ebayListingId: { in: ebayIds } },
        include: { product: true },
      });
      const byEbayId = new Map(listings.map((listing) => [listing.ebayListingId, listing]));
      const ebayHost = ebayEnvConfig()?.env === "PRODUCTION" ? "https://www.ebay.com" : "https://sandbox.ebay.com";
      rows = orders.map((order) => ({
        orderId: order.orderId,
        createdAt: order.createdAt.toISOString(),
        buyerUsername: order.buyerUsername,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        lines: order.lines.map((line) => {
          const listing = byEbayId.get(line.ebayListingId);
          const source = listing ? {
            title: listing.product.title,
            sku: listing.product.sku,
            url: listing.product.supplierUrl,
            imageUrl: parseImageUrls(listing.product.imageUrlsJson)[0] ?? null,
            unitCostCents: listing.product.costCents,
            shippingCostCents: listing.product.shippingCostCents,
            stock: listing.product.supplierStock,
          } : null;
          const salePerUnitWithShipping = line.salePriceCents + Math.round(line.shippingChargedCents / line.quantity);
          const margin = source ? estimateMargin(salePerUnitWithShipping, source.unitCostCents, source.shippingCostCents) : null;
          return {
            ...line,
            ebayUrl: `${ebayHost}/itm/${line.ebayListingId}`,
            shipByDate: line.shipByDate?.toISOString() ?? null,
            source,
            estimatedProfitCents: margin ? margin.estimatedProfitCents * line.quantity : null,
          };
        }),
      }));
    } catch (error) {
      fetchError = error instanceof Error ? error.message.slice(0, 300) : "eBay lookup failed";
    }
  }

  return (
    <>
      <PageHeader
        title="Orders to fulfill"
        subtitle="Paid eBay orders still awaiting shipment, paired with the exact Amazon source needed to fulfill them."
        actions={<Badge tone={ebayConnected ? "green" : "amber"}>{ebayConnected ? "Live from eBay" : "eBay not connected"}</Badge>}
      />
      <div className="relative left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 md:w-[calc(100vw-17rem)]">
        <OrdersView
          orders={rows}
          fetchError={fetchError ?? (!ebayConnected ? "Connect eBay in Settings first." : null)}
          purchaseHistory={purchaseHistory.flatMap((order) => order.amazonPurchaseItem ? [{
            id: order.id, ebayOrderId: order.ebayOrderId, ebayTitle: order.listing.title,
            amazonOrderId: order.amazonPurchaseItem.purchase.amazonOrderId, amazonTitle: order.amazonPurchaseItem.title,
            amazonUrl: order.amazonPurchaseItem.amazonUrl, purchasedAt: order.amazonPurchaseItem.purchase.purchasedAt?.toISOString() ?? null,
            sourcingStatus: order.sourcingStatus, trackingNumber: order.amazonPurchaseItem.purchase.trackingNumber,
            revenueCents: order.salePriceCents * order.quantity + order.shippingChargedCents, ebayFeeCents: order.ebayFeeCents,
            actualAmazonCostCents: actualAmazonCost(order.amazonPurchaseItem), estimatedAmazonCostCents: order.cogsCents + order.shippingCostCents,
            confidence: order.amazonPurchaseItem.matchConfidence,
          }] : [])}
          amazonPurchases={amazonPurchases.map((purchase) => ({
            id: purchase.id, amazonOrderId: purchase.amazonOrderId, purchasedAt: purchase.purchasedAt?.toISOString() ?? null,
            status: purchase.status, subtotalCents: purchase.subtotalCents, shippingCents: purchase.shippingCents,
            taxCents: purchase.taxCents, discountCents: purchase.discountCents, totalCents: purchase.totalCents,
            trackingNumber: purchase.trackingNumber, carrier: purchase.carrier,
            items: purchase.items.map((item) => ({ id: item.id, asin: item.asin, title: item.title, quantity: item.quantity, unitPriceCents: item.unitPriceCents, amazonUrl: item.amazonUrl, matched: !!item.matchedOrderId })),
          }))}
        />
      </div>
    </>
  );
}
