// Clean-up classifier: decide per listing whether to leave it, raise its
// price to a profitability target, or end it. Pure — no I/O.

import { EBAY_FINAL_VALUE_RATE, EBAY_PER_ORDER_FEE_CENTS } from "@/lib/fees";

/** Assumed eBay Promoted Listings (advertising) rate, applied to the sale
 * price alongside the final value fee when computing true profitability. */
export const AD_RATE = 0.03;

/** Targets: a listing is healthy when it clears either one. */
export const TARGET_MARGIN = 0.3;
export const TARGET_PROFIT_CENTS = 700;

/** Beyond this loss ratio, repricing would be futile — end the listing. */
export const END_MARGIN = -0.3;

/** Net profit per unit at a given price, including FVF, ad rate, per-order
 * fee, cost of goods, and outbound shipping. */
export function trueProfitCents(
  priceCents: number,
  costCents: number,
  shippingCostCents: number,
): number {
  const variableFees = Math.round(priceCents * (EBAY_FINAL_VALUE_RATE + AD_RATE));
  return (
    priceCents - variableFees - EBAY_PER_ORDER_FEE_CENTS - costCents - shippingCostCents
  );
}

/** Round UP to the next .99 charm price (never rounds below the input). */
export function charmCeilCents(priceCents: number): number {
  const charm = Math.ceil((priceCents + 1) / 100) * 100 - 1;
  return charm >= priceCents ? charm : charm + 100;
}

/**
 * The lowest price that reaches 30% margin OR $7/unit profit — whichever
 * target is achieved first as the price rises.
 */
export function targetPriceCents(
  costCents: number,
  shippingCostCents: number,
): number {
  const keep = 1 - EBAY_FINAL_VALUE_RATE - AD_RATE; // fraction of price kept
  const fixed = EBAY_PER_ORDER_FEE_CENTS + costCents + shippingCostCents;
  const priceForProfit = (TARGET_PROFIT_CENTS + fixed) / keep;
  const priceForMargin = fixed / (keep - TARGET_MARGIN);
  return charmCeilCents(Math.ceil(Math.min(priceForProfit, priceForMargin)));
}

/** A profitable, market-aware listing recommendation. The profitability
 * target is a hard floor; when competitor data exists, aim roughly 3% below
 * the average comp without ever crossing below that floor. */
export function suggestedListingPriceCents(
  costCents: number,
  shippingCostCents: number,
  averageCompetitorPriceCents?: number | null,
): number {
  const profitableFloor = targetPriceCents(costCents, shippingCostCents);
  if (!averageCompetitorPriceCents || averageCompetitorPriceCents <= 0) {
    return profitableFloor;
  }
  const competitiveTarget = charmCeilCents(
    Math.ceil(averageCompetitorPriceCents * 0.97),
  );
  return Math.max(profitableFloor, competitiveTarget);
}

export type CleanupDecision =
  | { action: "ok" }
  | { action: "reprice"; newPriceCents: number }
  | { action: "end" };

export function classifyListing(
  priceCents: number,
  costCents: number,
  shippingCostCents: number,
): CleanupDecision {
  const profit = trueProfitCents(priceCents, costCents, shippingCostCents);
  const margin = priceCents > 0 ? profit / priceCents : -1;

  if (margin >= TARGET_MARGIN || profit >= TARGET_PROFIT_CENTS) {
    return { action: "ok" };
  }
  if (margin <= END_MARGIN) {
    return { action: "end" };
  }
  const newPriceCents = targetPriceCents(costCents, shippingCostCents);
  // Never lower a price during clean-up; if the target math lands at or
  // below the current price (rounding edge), the listing is close enough.
  if (newPriceCents <= priceCents) return { action: "ok" };
  return { action: "reprice", newPriceCents };
}
