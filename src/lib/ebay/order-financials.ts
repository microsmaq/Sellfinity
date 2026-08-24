export type EbayFeeBreakdownEntry = {
  type: string;
  amountCents: number;
};

export type RemoteOrderFinancials = {
  orderId: string;
  grossAmountCents: number;
  orderEarningsCents: number;
  transactionFeeCents: number;
  advertisingFeeCents: number;
  otherFeeCents: number;
  shippingLabelCents: number;
  refundCents: number;
  feeBreakdown: EbayFeeBreakdownEntry[];
  updatedAt: Date | null;
};

type Amount = { value?: string };
type OrderEarningResponse = {
  orderId?: string;
  orderLastModifiedDate?: string;
  orderEarningsSummary?: {
    grossAmount?: Amount;
    orderEarnings?: Amount;
    refunds?: Amount;
    expenses?: {
      value?: string;
      marketplaceFees?: Array<{ feeType?: string; amount?: Amount }>;
      donations?: Array<{ feeType?: string; amount?: Amount }>;
      shippingLabels?: Amount;
    };
  };
};

function cents(amount: Amount | undefined): number {
  const value = Number(amount?.value ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function isAdvertisingFee(type: string): boolean {
  return type === "AD_FEE"
    || type.includes("PROMOTED_LISTING")
    || type.includes("PROMOTED_OFFSITE")
    || type.includes("ADVERTISING");
}

export function parseOrderFinancials(
  response: OrderEarningResponse,
  requestedOrderId: string,
): RemoteOrderFinancials | null {
  const summary = response.orderEarningsSummary;
  if (!summary?.orderEarnings || !summary.expenses) return null;
  const marketplaceFees = summary.expenses.marketplaceFees ?? [];
  const donations = summary.expenses.donations ?? [];
  const feeBreakdown = [...marketplaceFees, ...donations].flatMap((fee) => {
    const type = fee.feeType?.trim();
    return type ? [{ type, amountCents: cents(fee.amount) }] : [];
  });
  const advertisingFeeCents = feeBreakdown
    .filter((fee) => isAdvertisingFee(fee.type))
    .reduce((total, fee) => total + fee.amountCents, 0);
  const marketplaceNonAdCents = feeBreakdown
    .filter((fee) => !isAdvertisingFee(fee.type))
    .reduce((total, fee) => total + fee.amountCents, 0);
  const shippingLabelCents = cents(summary.expenses.shippingLabels);
  const expenseValue = Number(summary.expenses.value ?? 0);
  const totalExpensesCents = Number.isFinite(expenseValue) ? Math.round(expenseValue * 100) : 0;
  const categorized = marketplaceNonAdCents + advertisingFeeCents + shippingLabelCents;
  const otherFeeCents = Math.max(0, totalExpensesCents - categorized);
  const updatedAt = response.orderLastModifiedDate
    ? new Date(response.orderLastModifiedDate)
    : null;
  return {
    orderId: response.orderId ?? requestedOrderId,
    grossAmountCents: cents(summary.grossAmount),
    orderEarningsCents: cents(summary.orderEarnings),
    transactionFeeCents: marketplaceNonAdCents,
    advertisingFeeCents,
    otherFeeCents,
    shippingLabelCents,
    refundCents: cents(summary.refunds),
    feeBreakdown,
    updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
  };
}

export function allocateCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeWeights = weights.map((weight) => Math.max(0, weight));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) {
    const base = Math.trunc(totalCents / weights.length);
    const result = weights.map(() => base);
    result[result.length - 1] += totalCents - base * weights.length;
    return result;
  }
  let allocated = 0;
  return safeWeights.map((weight, index) => {
    if (index === safeWeights.length - 1) return totalCents - allocated;
    const amount = Math.round(totalCents * weight / totalWeight);
    allocated += amount;
    return amount;
  });
}
