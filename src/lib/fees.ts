// eBay fee model (US, managed payments, most categories, no eBay Store).
// Rates current as of mid-2026; centralized here so a category-aware or
// account-aware model can replace this without touching callers.

/** Final value fee: percentage of (item price + shipping charged). */
export const EBAY_FINAL_VALUE_RATE = 0.1325;
/** Conservative Promoted Listings allowance used for projected profitability. */
export const EBAY_AD_RATE = 0.03;
export const DEFAULT_EBAY_AD_RATE_BPS = 300;
/** Fixed per-order fee. */
export const EBAY_PER_ORDER_FEE_CENTS = 30;

export function normalizeSitewideDiscountBps(discountBps = 0): number {
  return Math.max(0, Math.min(9_000, Math.round(discountBps)));
}

export function normalizeAdRateBps(adRateBps = DEFAULT_EBAY_AD_RATE_BPS): number {
  return Math.max(0, Math.min(5_000, Math.round(adRateBps)));
}

/** Modeled Promoted Listings spend. Applied to gross buyer revenue. */
export function ebayAdvertisingFeeCents(
  grossCents: number,
  adRateBps = DEFAULT_EBAY_AD_RATE_BPS,
): number {
  return Math.round(Math.max(0, grossCents) * normalizeAdRateBps(adRateBps) / 10_000);
}

/** Buyer checkout price after a seller-wide percentage discount. */
export function discountedEbayPriceCents(listPriceCents: number, discountBps = 0): number {
  return Math.floor(
    listPriceCents * (10_000 - normalizeSitewideDiscountBps(discountBps)) / 10_000,
  );
}

/** Smallest list price whose discounted checkout price reaches the target. */
export function grossUpEbayPriceCents(buyerPriceCents: number, discountBps = 0): number {
  const safeDiscountBps = normalizeSitewideDiscountBps(discountBps);
  if (safeDiscountBps === 0) return Math.round(buyerPriceCents);
  let listPriceCents = Math.ceil(buyerPriceCents * 10_000 / (10_000 - safeDiscountBps));
  while (discountedEbayPriceCents(listPriceCents, safeDiscountBps) < buyerPriceCents) listPriceCents++;
  while (listPriceCents > 0 && discountedEbayPriceCents(listPriceCents - 1, safeDiscountBps) >= buyerPriceCents) listPriceCents--;
  return listPriceCents;
}

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
  sitewideDiscountBps = 0,
  adRateBps = DEFAULT_EBAY_AD_RATE_BPS,
): MarginEstimate {
  const buyerPriceCents = discountedEbayPriceCents(marketPriceCents, sitewideDiscountBps);
  const estimatedFeeCents =
    ebayFeeCents({
      quantity: 1,
      salePriceCents: buyerPriceCents,
      shippingChargedCents: 0,
    }) + ebayAdvertisingFeeCents(buyerPriceCents, adRateBps);
  const estimatedProfitCents =
    buyerPriceCents - estimatedFeeCents - costCents - shippingCostCents;
  const marginPct =
    buyerPriceCents > 0 ? (estimatedProfitCents / buyerPriceCents) * 100 : 0;
  return { estimatedFeeCents, estimatedProfitCents, marginPct };
}
