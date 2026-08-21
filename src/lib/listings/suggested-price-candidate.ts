import { discountedEbayPriceCents } from "@/lib/fees";
import { AI_MIN_MARGIN, trueProfitCents } from "./cleanup";

export type SuggestedPriceCandidateInput = {
  currentPriceCents: number;
  suggestedPriceCents: number | null;
  amazonPriceCents: number;
  shippingCostCents: number;
  sitewideDiscountBps?: number;
  adRateBps?: number;
};

/** Queue only changed prices that still clear the hard profitability floor. */
export function isSuggestedPriceCandidate(input: SuggestedPriceCandidateInput): boolean {
  const suggested = input.suggestedPriceCents;
  if (suggested === null || suggested <= 0 || suggested === input.currentPriceCents) return false;

  const buyerPriceCents = discountedEbayPriceCents(suggested, input.sitewideDiscountBps ?? 0);
  if (buyerPriceCents <= 0) return false;
  const profitCents = trueProfitCents(
    suggested,
    input.amazonPriceCents,
    input.shippingCostCents,
    input.sitewideDiscountBps,
    input.adRateBps,
  );
  return profitCents > 0 && profitCents / buyerPriceCents >= AI_MIN_MARGIN;
}
