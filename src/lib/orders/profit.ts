import { ebayAdvertisingFeeCents, DEFAULT_EBAY_AD_RATE_BPS } from "@/lib/fees";

export type OrderProfitInput = {
  quantity: number;
  salePriceCents: number;
  shippingChargedCents: number;
  ebayFeeCents: number;
  cogsCents: number;
  shippingCostCents: number;
  actualAmazonCostCents?: number | null;
  ebayFinancialsSource?: string | null;
  ebayGrossAmountCents?: number | null;
  ebayOrderEarningsCents?: number | null;
  ebayTransactionFeeCents?: number | null;
  ebayAdvertisingFeeCents?: number | null;
  ebayOtherFeeCents?: number | null;
  ebayShippingLabelCents?: number | null;
  ebayRefundCents?: number | null;
};

export type OrderProfitBreakdown = {
  actualEbayFinancials: boolean;
  verifiedAmazonCost: boolean;
  revenueCents: number;
  transactionFeeCents: number;
  advertisingFeeCents: number;
  otherEbayCostCents: number;
  shippingLabelCents: number;
  refundCents: number;
  amazonCostCents: number;
  totalCostCents: number;
  profitCents: number;
};

export function orderProfitBreakdown(
  order: OrderProfitInput,
  adRateBps = DEFAULT_EBAY_AD_RATE_BPS,
): OrderProfitBreakdown {
  const modeledRevenue = order.salePriceCents * order.quantity + order.shippingChargedCents;
  const actualEbayFinancials = order.ebayFinancialsSource === "ACTUAL"
    && order.ebayOrderEarningsCents !== null
    && order.ebayOrderEarningsCents !== undefined;
  const revenueCents = actualEbayFinancials && order.ebayGrossAmountCents != null
    ? order.ebayGrossAmountCents
    : modeledRevenue;
  const transactionFeeCents = actualEbayFinancials
    ? order.ebayTransactionFeeCents ?? order.ebayFeeCents
    : order.ebayFeeCents;
  const advertisingFeeCents = actualEbayFinancials
    ? order.ebayAdvertisingFeeCents ?? 0
    : ebayAdvertisingFeeCents(modeledRevenue, adRateBps);
  const shippingLabelCents = actualEbayFinancials ? order.ebayShippingLabelCents ?? 0 : 0;
  const refundCents = actualEbayFinancials ? order.ebayRefundCents ?? 0 : 0;
  const knownDeductions = transactionFeeCents + advertisingFeeCents + shippingLabelCents + refundCents;
  const reconciledDeductions = actualEbayFinancials
    ? Math.max(0, revenueCents - (order.ebayOrderEarningsCents ?? revenueCents))
    : knownDeductions;
  const otherEbayCostCents = actualEbayFinancials
    ? Math.max(order.ebayOtherFeeCents ?? 0, reconciledDeductions - knownDeductions)
    : 0;
  const verifiedAmazonCost = order.actualAmazonCostCents !== null
    && order.actualAmazonCostCents !== undefined;
  const amazonCostCents = verifiedAmazonCost
    ? order.actualAmazonCostCents!
    : order.cogsCents + order.shippingCostCents;
  const totalCostCents = transactionFeeCents
    + advertisingFeeCents
    + otherEbayCostCents
    + shippingLabelCents
    + refundCents
    + amazonCostCents;
  const profitCents = actualEbayFinancials
    ? (order.ebayOrderEarningsCents ?? revenueCents) - amazonCostCents
    : modeledRevenue - totalCostCents;
  return {
    actualEbayFinancials,
    verifiedAmazonCost,
    revenueCents,
    transactionFeeCents,
    advertisingFeeCents,
    otherEbayCostCents,
    shippingLabelCents,
    refundCents,
    amazonCostCents,
    totalCostCents,
    profitCents,
  };
}
