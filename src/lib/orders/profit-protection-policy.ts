import { EBAY_FINAL_VALUE_RATE, EBAY_PER_ORDER_FEE_CENTS } from "@/lib/fees";

export const VERIFIED_MARGIN_TARGET_BPS = 500;
export const VERIFIED_PROFIT_TARGET_CENTS = 700;

export type VerifiedProfitDecision =
  | { action: "not_required"; realizedProfitCents: number; realizedMarginBps: number }
  | { action: "already_protected"; realizedProfitCents: number; realizedMarginBps: number; targetPriceCents: number }
  | { action: "reprice"; realizedProfitCents: number; realizedMarginBps: number; targetPriceCents: number };

function futureProfitCents(priceCents: number, unitCostCents: number, variableFeeBps: number): number {
  const fee = Math.ceil((priceCents * variableFeeBps) / 10_000) + EBAY_PER_ORDER_FEE_CENTS;
  return priceCents - fee - unitCostCents;
}

function clearsFutureFloor(priceCents: number, unitCostCents: number, variableFeeBps: number): boolean {
  const profit = futureProfitCents(priceCents, unitCostCents, variableFeeBps);
  return profit >= VERIFIED_PROFIT_TARGET_CENTS || profit * 10_000 >= priceCents * VERIFIED_MARGIN_TARGET_BPS;
}

/**
 * Use a completed order's verified landed Amazon cost and observed eBay fee
 * rate to decide whether its active listing should be raised for future sales.
 * Low/medium priced items clear 5%; expensive items may instead clear the $7
 * absolute net-profit target so the protection does not overprice them.
 */
export function verifiedProfitProtectionDecision(input: {
  currentListingPriceCents: number;
  orderQuantity: number;
  realizedRevenueCents: number;
  realizedEbayFeeCents: number;
  verifiedAmazonCostCents: number;
}): VerifiedProfitDecision {
  const realizedProfitCents = input.realizedRevenueCents - input.realizedEbayFeeCents - input.verifiedAmazonCostCents;
  const realizedMarginBps = input.realizedRevenueCents > 0
    ? Math.floor((realizedProfitCents * 10_000) / input.realizedRevenueCents)
    : -10_000;

  if (realizedProfitCents >= VERIFIED_PROFIT_TARGET_CENTS || realizedMarginBps >= VERIFIED_MARGIN_TARGET_BPS) {
    return { action: "not_required", realizedProfitCents, realizedMarginBps };
  }

  const quantity = Math.max(1, input.orderQuantity);
  const unitCostCents = Math.ceil(input.verifiedAmazonCostCents / quantity);
  const observedVariableFeeBps = input.realizedRevenueCents > 0
    ? Math.ceil((Math.max(0, input.realizedEbayFeeCents - EBAY_PER_ORDER_FEE_CENTS) * 10_000) / input.realizedRevenueCents)
    : 0;
  const variableFeeBps = Math.max(Math.round(EBAY_FINAL_VALUE_RATE * 10_000), observedVariableFeeBps);

  // Solve both targets, then take the cheaper one because the policy is 5%
  // OR $7 net profit. Verify with integer fee rounding before returning.
  const marginDenominator = 10_000 - variableFeeBps - VERIFIED_MARGIN_TARGET_BPS;
  const fivePercentPrice = marginDenominator > 0
    ? Math.ceil(((unitCostCents + EBAY_PER_ORDER_FEE_CENTS) * 10_000) / marginDenominator)
    : Number.MAX_SAFE_INTEGER;
  const sevenDollarPrice = Math.ceil(
    ((unitCostCents + EBAY_PER_ORDER_FEE_CENTS + VERIFIED_PROFIT_TARGET_CENTS) * 10_000) /
      (10_000 - variableFeeBps),
  );
  let targetPriceCents = Math.min(fivePercentPrice, sevenDollarPrice);
  while (!clearsFutureFloor(targetPriceCents, unitCostCents, variableFeeBps)) targetPriceCents++;
  while (targetPriceCents > 0 && clearsFutureFloor(targetPriceCents - 1, unitCostCents, variableFeeBps)) targetPriceCents--;

  if (targetPriceCents <= input.currentListingPriceCents) {
    return { action: "already_protected", realizedProfitCents, realizedMarginBps, targetPriceCents };
  }
  return { action: "reprice", realizedProfitCents, realizedMarginBps, targetPriceCents };
}
