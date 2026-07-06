// eBay fee model (US, managed payments, most categories, no eBay Store).
// Rates current as of mid-2026; centralized here so a category-aware or
// account-aware model can replace this without touching callers.

/** Final value fee: percentage of (item price + shipping charged). */
export const EBAY_FINAL_VALUE_RATE = 0.1325;
/** Fixed per-order fee. */
export const EBAY_PER_ORDER_FEE_CENTS = 30;

export type OrderAmounts = {
  quantity: number;
  salePriceCents: number; // per unit
  shippingChargedCents: number; // total charged to buyer
};

/** Total eBay fee (final value fee incl. payment processing + per-order fixed fee). */
export function ebayFeeCents(order: OrderAmounts): number {
  const gross = order.salePriceCents * order.quantity + order.shippingChargedCents;
  return Math.round(gross * EBAY_FINAL_VALUE_RATE) + EBAY_PER_ORDER_FEE_CENTS;
}

export type ProfitInputs = OrderAmounts & {
  ebayFeeCents: number;
  shippingCostCents: number; // what the seller actually paid to ship
  cogsCents: number; // total cost of goods for the order
};

export function grossRevenueCents(o: OrderAmounts): number {
  return o.salePriceCents * o.quantity + o.shippingChargedCents;
}

export function netProfitCents(o: ProfitInputs): number {
  return grossRevenueCents(o) - o.ebayFeeCents - o.shippingCostCents - o.cogsCents;
}

export type MarginEstimate = {
  estimatedFeeCents: number;
  estimatedProfitCents: number; // per unit
  marginPct: number; // profit / sale price, 0-100
};

/**
 * Estimate per-unit margin for a sourcing candidate: sale at marketPriceCents
 * with free shipping (seller pays shippingCostCents to fulfill).
 */
export function estimateMargin(
  marketPriceCents: number,
  costCents: number,
  shippingCostCents: number,
): MarginEstimate {
  const estimatedFeeCents = ebayFeeCents({
    quantity: 1,
    salePriceCents: marketPriceCents,
    shippingChargedCents: 0,
  });
  const estimatedProfitCents =
    marketPriceCents - estimatedFeeCents - costCents - shippingCostCents;
  const marginPct =
    marketPriceCents > 0 ? (estimatedProfitCents / marketPriceCents) * 100 : 0;
  return { estimatedFeeCents, estimatedProfitCents, marginPct };
}
