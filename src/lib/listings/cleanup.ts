// Clean-up classifier: decide per listing whether to leave it, raise its
// price to a profitability target, or end it. Pure — no I/O.

import { EBAY_FINAL_VALUE_RATE, EBAY_PER_ORDER_FEE_CENTS } from "@/lib/fees";

/** Assumed eBay Promoted Listings (advertising) rate, applied to the sale
 * price alongside the final value fee when computing true profitability. */
export const AD_RATE = 0.03;

/** Targets: a listing is healthy when it clears either one. */
export const TARGET_MARGIN = 0.3;
export const TARGET_PROFIT_CENTS = 700;

/** AI competitive pricing aims for 20%, but will move as low as 15% when
 * doing so keeps the listing close to the eBay market recommendation. */
export const AI_TARGET_MARGIN = 0.2;
export const AI_MIN_MARGIN = 0.15;

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

/** Lowest exact price that clears a percentage margin after selling fees,
 * promoted-listing spend, product cost, and outbound shipping. */
export function marginFloorPriceCents(
  costCents: number,
  shippingCostCents: number,
  margin: number,
): number {
  const keep = 1 - EBAY_FINAL_VALUE_RATE - AD_RATE;
  const fixed = EBAY_PER_ORDER_FEE_CENTS + costCents + shippingCostCents;
  let price = Math.max(99, Math.ceil(fixed / (keep - margin)));
  // trueProfitCents rounds variable fees to cents, so close the occasional
  // one-cent rounding gap rather than ever returning below the hard margin.
  while (trueProfitCents(price, costCents, shippingCostCents) / price < margin) {
    price++;
  }
  return price;
}

/**
 * AI-assisted listing recommendation based on live eBay market research.
 * It chooses the price closest to the strongest estimated-demand comparable,
 * stays at/below the market average when that is feasible, targets 20%
 * margin, and never crosses the hard 15% profitability floor.
 */
export function aiSuggestedListingPriceCents(
  costCents: number,
  shippingCostCents: number,
  ebayRecommendedPriceCents?: number | null,
  averageCompetitorPriceCents?: number | null,
): number {
  const minimum = marginFloorPriceCents(
    costCents,
    shippingCostCents,
    AI_MIN_MARGIN,
  );
  const preferred = marginFloorPriceCents(
    costCents,
    shippingCostCents,
    AI_TARGET_MARGIN,
  );
  const average =
    averageCompetitorPriceCents && averageCompetitorPriceCents > 0
      ? averageCompetitorPriceCents
      : null;
  const anchor =
    ebayRecommendedPriceCents && ebayRecommendedPriceCents > 0
      ? ebayRecommendedPriceCents
      : average
        ? Math.round(average * 0.97)
        : preferred;

  if (!average) return Math.max(preferred, anchor);
  if (average >= preferred) {
    return Math.min(average, Math.max(preferred, anchor));
  }
  if (average >= minimum) {
    return Math.min(average, Math.max(minimum, anchor));
  }
  // No price at or below the average can clear 15%; profitability wins and
  // the UI explicitly identifies this above-market exception.
  return minimum;
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
