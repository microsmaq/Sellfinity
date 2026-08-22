import {
  EBAY_FINAL_VALUE_RATE,
  EBAY_PER_ORDER_FEE_CENTS,
  DEFAULT_EBAY_AD_RATE_BPS,
  discountedEbayPriceCents,
  grossUpEbayPriceCents,
  normalizeAdRateBps,
} from "@/lib/fees";
import { aiSuggestedListingPriceCents, trueProfitCents } from "./cleanup";

export const MAX_BUYER_SHIPPING_CENTS = 700;

export type PricingStrategy = "AI" | "FREE_SHIPPING" | "BUYER_PAID_SHIPPING";
export type ListingShippingStrategy = "FREE_SHIPPING" | "BUYER_PAID_SHIPPING";

export type ListingPricePlan = {
  itemPriceCents: number;
  buyerShippingCents: number;
  shippingStrategy: ListingShippingStrategy;
  modeledProfitCents: number;
};

export function normalizePricingStrategy(value: string | null | undefined): PricingStrategy {
  return value === "FREE_SHIPPING" || value === "BUYER_PAID_SHIPPING" ? value : "AI";
}

/** Modeled per-unit profit. eBay charges percentage fees on the total buyer
 * payment, including seller-charged shipping; sitewide promotions discount
 * the item price but normally do not discount shipping. */
export function trueProfitWithBuyerShippingCents(
  itemPriceCents: number,
  buyerShippingCents: number,
  amazonCostCents: number,
  amazonShippingCents: number,
  sitewideDiscountBps = 0,
  adRateBps = DEFAULT_EBAY_AD_RATE_BPS,
): number {
  const buyerItemCents = discountedEbayPriceCents(itemPriceCents, sitewideDiscountBps);
  const buyerTotalCents = buyerItemCents + Math.max(0, buyerShippingCents);
  const variableFees =
    Math.round(buyerTotalCents * EBAY_FINAL_VALUE_RATE) +
    Math.round(buyerTotalCents * normalizeAdRateBps(adRateBps) / 10_000);
  return buyerTotalCents - variableFees - EBAY_PER_ORDER_FEE_CENTS - amazonCostCents - amazonShippingCents;
}

function positive(value?: number | null): number | null {
  return value !== null && value !== undefined && value > 0 ? Math.round(value) : null;
}

function minimumItemPriceForProfit(
  targetProfitCents: number,
  buyerShippingCents: number,
  amazonCostCents: number,
  amazonShippingCents: number,
  sitewideDiscountBps: number,
  adRateBps: number,
): number {
  let low = 99;
  let high = Math.max(99, amazonCostCents + amazonShippingCents + targetProfitCents + 5_000);
  while (trueProfitWithBuyerShippingCents(high, buyerShippingCents, amazonCostCents, amazonShippingCents, sitewideDiscountBps, adRateBps) < targetProfitCents) {
    high *= 2;
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (trueProfitWithBuyerShippingCents(mid, buyerShippingCents, amazonCostCents, amazonShippingCents, sitewideDiscountBps, adRateBps) >= targetProfitCents) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Choose an item price and shipping presentation without lowering the profit
 * produced by the existing market-aware recommendation. AI uses free shipping
 * whenever that price is already at or below the strongest market anchor. */
export function listingPricePlan(input: {
  amazonCostCents: number;
  amazonShippingCents: number;
  currentEbayPriceCents?: number | null;
  ebayRecommendedPriceCents?: number | null;
  averageCompetitorPriceCents?: number | null;
  sitewideDiscountBps?: number;
  adRateBps?: number;
  targetProfitCents?: number | null;
  pricingStrategy?: string | null;
}): ListingPricePlan {
  const sitewideDiscountBps = input.sitewideDiscountBps ?? 0;
  const adRateBps = input.adRateBps ?? DEFAULT_EBAY_AD_RATE_BPS;
  const strategy = normalizePricingStrategy(input.pricingStrategy);
  const freePrice = aiSuggestedListingPriceCents(
    input.amazonCostCents,
    input.amazonShippingCents,
    input.ebayRecommendedPriceCents,
    input.averageCompetitorPriceCents,
    sitewideDiscountBps,
    adRateBps,
    input.targetProfitCents ?? null,
  );
  const profitGoal = input.targetProfitCents === null || input.targetProfitCents === undefined
    ? trueProfitCents(freePrice, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps)
    : Math.max(0, Math.round(input.targetProfitCents));
  const observedMarketValues = [
    positive(input.ebayRecommendedPriceCents),
    positive(input.averageCompetitorPriceCents),
  ].filter((value): value is number => value !== null);
  const marketValues = observedMarketValues.length
    ? observedMarketValues
    : [positive(input.currentEbayPriceCents)].filter((value): value is number => value !== null);
  const marketAnchor = marketValues.length ? Math.min(...marketValues) : null;
  const freePlan = (): ListingPricePlan => ({
    itemPriceCents: freePrice,
    buyerShippingCents: 0,
    shippingStrategy: "FREE_SHIPPING",
    modeledProfitCents: trueProfitWithBuyerShippingCents(freePrice, 0, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps),
  });

  if (strategy === "FREE_SHIPPING") return freePlan();
  if (strategy === "AI" && (!marketAnchor || discountedEbayPriceCents(freePrice, sitewideDiscountBps) <= marketAnchor)) return freePlan();

  // In AI mode, match the lowest observed item price first. In explicitly
  // buyer-paid mode, use the full allowed shipping amount to minimize the
  // headline item price while preserving the same modeled profit.
  let buyerShippingCents = strategy === "BUYER_PAID_SHIPPING" ? MAX_BUYER_SHIPPING_CENTS : 0;
  let itemPriceCents = marketAnchor ? Math.max(99, grossUpEbayPriceCents(marketAnchor, sitewideDiscountBps)) : freePrice;
  if (strategy === "BUYER_PAID_SHIPPING") {
    itemPriceCents = minimumItemPriceForProfit(profitGoal, buyerShippingCents, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps);
  } else {
    while (
      buyerShippingCents < MAX_BUYER_SHIPPING_CENTS &&
      trueProfitWithBuyerShippingCents(itemPriceCents, buyerShippingCents, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps) < profitGoal
    ) buyerShippingCents++;
  }
  if (trueProfitWithBuyerShippingCents(itemPriceCents, buyerShippingCents, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps) < profitGoal) {
    itemPriceCents = minimumItemPriceForProfit(profitGoal, buyerShippingCents, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps);
  }
  return {
    itemPriceCents,
    buyerShippingCents,
    shippingStrategy: "BUYER_PAID_SHIPPING",
    modeledProfitCents: trueProfitWithBuyerShippingCents(itemPriceCents, buyerShippingCents, input.amazonCostCents, input.amazonShippingCents, sitewideDiscountBps, adRateBps),
  };
}

