// Clean-up classifier: decide per listing whether to leave it, raise its
// price to a profitability target, or end it. Pure — no I/O.

import {
  EBAY_AD_RATE,
  EBAY_FINAL_VALUE_RATE,
  EBAY_PER_ORDER_FEE_CENTS,
  discountedEbayPriceCents,
  grossUpEbayPriceCents,
  normalizeSitewideDiscountBps,
} from "@/lib/fees";

/** Assumed eBay Promoted Listings (advertising) rate, applied to the sale
 * price alongside the final value fee when computing true profitability. */
export const AD_RATE = EBAY_AD_RATE;

/** Targets: a listing is healthy when it clears either one. */
export const TARGET_MARGIN = 0.3;
export const TARGET_PROFIT_CENTS = 700;

/** AI competitive pricing aims for 20%, but will move as low as 15% when
 * doing so keeps the listing close to the eBay market recommendation. */
export const AI_TARGET_MARGIN = 0.2;
export const AI_MIN_MARGIN = 0.15;
/** On higher-cost products, percentage margins scale into an unnecessarily
 * large dollar profit and push the listing away from the market. */
export const AI_MAX_TARGET_PROFIT_CENTS = 700;

/** Beyond this loss ratio, repricing would be futile — end the listing. */
export const END_MARGIN = -0.3;

/** Net profit per unit at a given price, including FVF, ad rate, per-order
 * fee, cost of goods, and outbound shipping. */
export function trueProfitCents(
  priceCents: number,
  costCents: number,
  shippingCostCents: number,
  sitewideDiscountBps = 0,
): number {
  const buyerPriceCents = discountedEbayPriceCents(priceCents, sitewideDiscountBps);
  // eBay's final-value fee and the advertising allowance are charged and
  // rounded separately. Keep this identical to estimateMargin/ebayFeeCents so
  // the 15% floor cannot miss by a cent at rounding boundaries.
  const variableFees =
    Math.round(buyerPriceCents * EBAY_FINAL_VALUE_RATE) +
    Math.round(buyerPriceCents * AD_RATE);
  return (
    buyerPriceCents - variableFees - EBAY_PER_ORDER_FEE_CENTS - costCents - shippingCostCents
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
  sitewideDiscountBps = 0,
): number {
  const keep = 1 - EBAY_FINAL_VALUE_RATE - AD_RATE; // fraction of price kept
  const fixed = EBAY_PER_ORDER_FEE_CENTS + costCents + shippingCostCents;
  const priceForProfit = (TARGET_PROFIT_CENTS + fixed) / keep;
  const priceForMargin = fixed / (keep - TARGET_MARGIN);
  return charmCeilCents(grossUpEbayPriceCents(
    Math.ceil(Math.min(priceForProfit, priceForMargin)),
    sitewideDiscountBps,
  ));
}

/** Lowest exact price that clears a percentage margin after selling fees,
 * promoted-listing spend, product cost, and outbound shipping. */
export function marginFloorPriceCents(
  costCents: number,
  shippingCostCents: number,
  margin: number,
  sitewideDiscountBps = 0,
): number {
  const keep = 1 - EBAY_FINAL_VALUE_RATE - AD_RATE;
  const fixed = EBAY_PER_ORDER_FEE_CENTS + costCents + shippingCostCents;
  let price = Math.max(99, grossUpEbayPriceCents(
    Math.ceil(fixed / (keep - margin)),
    sitewideDiscountBps,
  ));
  // trueProfitCents rounds variable fees to cents, so close the occasional
  // one-cent rounding gap rather than ever returning below the hard margin.
  while (
    trueProfitCents(price, costCents, shippingCostCents, sitewideDiscountBps) /
      discountedEbayPriceCents(price, sitewideDiscountBps) < margin
  ) {
    price++;
  }
  return price;
}

/** Highest sale price whose modeled net profit does not exceed the requested
 * dollar target. Used as a cap only when the percentage floor would earn more. */
export function profitCapPriceCents(
  costCents: number,
  shippingCostCents: number,
  profitCents = AI_MAX_TARGET_PROFIT_CENTS,
  sitewideDiscountBps = 0,
): number {
  const keep = 1 - EBAY_FINAL_VALUE_RATE - AD_RATE;
  const fixed = EBAY_PER_ORDER_FEE_CENTS + costCents + shippingCostCents;
  let price = Math.max(99, grossUpEbayPriceCents(
    Math.floor((fixed + profitCents) / keep),
    sitewideDiscountBps,
  ));
  while (price > 99 && trueProfitCents(price, costCents, shippingCostCents, sitewideDiscountBps) > profitCents) {
    price--;
  }
  while (
    trueProfitCents(price + 1, costCents, shippingCostCents, sitewideDiscountBps) <= profitCents
  ) {
    price++;
  }
  return price;
}

/**
 * AI-assisted listing recommendation based on live eBay market research.
 * It chooses the price closest to the strongest estimated-demand comparable,
 * stays at/below the market average when that is feasible, targets 20%
 * margin. For higher-cost products, the percentage rule is capped at $7 net
 * profit so the recommendation does not drift unnecessarily above the market.
 */
export function aiSuggestedListingPriceCents(
  costCents: number,
  shippingCostCents: number,
  ebayRecommendedPriceCents?: number | null,
  averageCompetitorPriceCents?: number | null,
  sitewideDiscountBps = 0,
): number {
  const discountBps = normalizeSitewideDiscountBps(sitewideDiscountBps);
  if (discountBps > 0) {
    return grossUpEbayPriceCents(
      aiSuggestedListingPriceCents(
        costCents,
        shippingCostCents,
        ebayRecommendedPriceCents,
        averageCompetitorPriceCents,
      ),
      discountBps,
    );
  }
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

  let suggested: number;
  if (!average) {
    suggested = Math.max(preferred, anchor);
  } else if (average >= preferred) {
    suggested = Math.min(average, Math.max(preferred, anchor));
  } else if (average >= minimum) {
    suggested = Math.min(average, Math.max(minimum, anchor));
  } else {
    // No price at or below the average can clear 15%; profitability wins.
    suggested = minimum;
  }

  if (
    trueProfitCents(minimum, costCents, shippingCostCents) >
    AI_MAX_TARGET_PROFIT_CENTS
  ) {
    return Math.min(
      suggested,
      profitCapPriceCents(costCents, shippingCostCents),
    );
  }
  return suggested;
}

/** A profitable, market-aware listing recommendation. The profitability
 * target is a hard floor; when competitor data exists, aim roughly 3% below
 * the average comp without ever crossing below that floor. */
export function suggestedListingPriceCents(
  costCents: number,
  shippingCostCents: number,
  averageCompetitorPriceCents?: number | null,
  sitewideDiscountBps = 0,
): number {
  const discountBps = normalizeSitewideDiscountBps(sitewideDiscountBps);
  if (discountBps > 0) {
    return grossUpEbayPriceCents(
      suggestedListingPriceCents(costCents, shippingCostCents, averageCompetitorPriceCents),
      discountBps,
    );
  }
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
  sitewideDiscountBps = 0,
): CleanupDecision {
  const buyerPriceCents = discountedEbayPriceCents(priceCents, sitewideDiscountBps);
  const profit = trueProfitCents(priceCents, costCents, shippingCostCents, sitewideDiscountBps);
  const margin = buyerPriceCents > 0 ? profit / buyerPriceCents : -1;

  if (margin >= TARGET_MARGIN || profit >= TARGET_PROFIT_CENTS) {
    return { action: "ok" };
  }
  if (margin <= END_MARGIN) {
    return { action: "end" };
  }
  const newPriceCents = targetPriceCents(costCents, shippingCostCents, sitewideDiscountBps);
  // Never lower a price during clean-up; if the target math lands at or
  // below the current price (rounding edge), the listing is close enough.
  if (newPriceCents <= priceCents) return { action: "ok" };
  return { action: "reprice", newPriceCents };
}
