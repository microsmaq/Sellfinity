import { discountedEbayPriceCents, ebayAdvertisingFeeCents, EBAY_FINAL_VALUE_RATE, EBAY_PER_ORDER_FEE_CENTS, normalizeAdRateBps } from "@/lib/fees";

export const VERIFIED_MARGIN_TARGET_BPS = 500;
export const VERIFIED_PROFIT_TARGET_CENTS = 700;

export function isEndedEbayListingError(message: string): boolean {
  return /not allowed to revise an ended item|listing (?:has )?ended|ended item/i.test(message);
}

export type VerifiedProfitDecision =
  | { action: "not_required"; realizedProfitCents: number; realizedMarginBps: number }
  | { action: "already_protected"; realizedProfitCents: number; realizedMarginBps: number; targetPriceCents: number }
  | { action: "reprice"; realizedProfitCents: number; realizedMarginBps: number; targetPriceCents: number };

export function discountedSalePriceCents(listPriceCents: number, discountBps: number): number {
  return discountedEbayPriceCents(listPriceCents, discountBps);
}

function futureProfitCents(listPriceCents: number, unitCostCents: number, variableFeeBps: number, discountBps: number): number {
  const salePriceCents = discountedSalePriceCents(listPriceCents, discountBps);
  const fee = Math.ceil((salePriceCents * variableFeeBps) / 10_000) + EBAY_PER_ORDER_FEE_CENTS;
  return salePriceCents - fee - unitCostCents;
}

function clearsFutureFloor(listPriceCents: number, unitCostCents: number, variableFeeBps: number, discountBps: number, targetProfitCents: number | null): boolean {
  const salePriceCents = discountedSalePriceCents(listPriceCents, discountBps);
  const profit = futureProfitCents(listPriceCents, unitCostCents, variableFeeBps, discountBps);
  return targetProfitCents !== null
    ? profit >= targetProfitCents
    : profit >= VERIFIED_PROFIT_TARGET_CENTS || profit * 10_000 >= salePriceCents * VERIFIED_MARGIN_TARGET_BPS;
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
  realizedAdvertisingFeeCents?: number;
  verifiedAmazonCostCents: number;
  sitewideDiscountBps?: number;
  adRateBps?: number;
  targetProfitCents?: number | null;
}): VerifiedProfitDecision {
  const adRateBps = normalizeAdRateBps(input.adRateBps);
  const totalRealizedFeeCents = input.realizedEbayFeeCents
    + (input.realizedAdvertisingFeeCents
      ?? ebayAdvertisingFeeCents(input.realizedRevenueCents, adRateBps));
  const realizedProfitCents = input.realizedRevenueCents - totalRealizedFeeCents - input.verifiedAmazonCostCents;
  const realizedMarginBps = input.realizedRevenueCents > 0
    ? Math.floor((realizedProfitCents * 10_000) / input.realizedRevenueCents)
    : -10_000;

  const configuredTarget = input.targetProfitCents === null || input.targetProfitCents === undefined
    ? null
    : Math.max(0, Math.round(input.targetProfitCents));
  const realizedTargetCents = configuredTarget === null
    ? VERIFIED_PROFIT_TARGET_CENTS
    : configuredTarget * Math.max(1, input.orderQuantity);
  const realizedClearsTarget = configuredTarget === null
    ? realizedProfitCents >= VERIFIED_PROFIT_TARGET_CENTS || realizedMarginBps >= VERIFIED_MARGIN_TARGET_BPS
    : realizedProfitCents >= realizedTargetCents;
  if (realizedClearsTarget) {
    return { action: "not_required", realizedProfitCents, realizedMarginBps };
  }

  const quantity = Math.max(1, input.orderQuantity);
  const unitCostCents = Math.ceil(input.verifiedAmazonCostCents / quantity);
  const observedVariableFeeBps = input.realizedRevenueCents > 0
    ? Math.ceil((Math.max(0, totalRealizedFeeCents - EBAY_PER_ORDER_FEE_CENTS) * 10_000) / input.realizedRevenueCents)
    : 0;
  const variableFeeBps = Math.max(Math.round(EBAY_FINAL_VALUE_RATE * 10_000) + adRateBps, observedVariableFeeBps);
  const discountBps = Math.max(0, Math.min(9_000, Math.round(input.sitewideDiscountBps ?? 0)));

  // A configured target is authoritative. Otherwise retain the legacy 5%
  // OR $7 policy. Verify with integer fee rounding before returning.
  const marginDenominator = 10_000 - variableFeeBps - VERIFIED_MARGIN_TARGET_BPS;
  const fivePercentPrice = marginDenominator > 0
    ? Math.ceil(((unitCostCents + EBAY_PER_ORDER_FEE_CENTS) * 10_000) / marginDenominator)
    : Number.MAX_SAFE_INTEGER;
  const sevenDollarPrice = Math.ceil(
    ((unitCostCents + EBAY_PER_ORDER_FEE_CENTS + VERIFIED_PROFIT_TARGET_CENTS) * 10_000) /
      (10_000 - variableFeeBps),
  );
  const configuredProfitPrice = configuredTarget === null
    ? Number.MAX_SAFE_INTEGER
    : Math.ceil(
        ((unitCostCents + EBAY_PER_ORDER_FEE_CENTS + configuredTarget) * 10_000) /
          (10_000 - variableFeeBps),
      );
  const targetSalePriceCents = configuredTarget === null
    ? Math.min(fivePercentPrice, sevenDollarPrice)
    : configuredProfitPrice;
  let targetPriceCents = Math.ceil((targetSalePriceCents * 10_000) / (10_000 - discountBps));
  while (!clearsFutureFloor(targetPriceCents, unitCostCents, variableFeeBps, discountBps, configuredTarget)) targetPriceCents++;
  while (targetPriceCents > 0 && clearsFutureFloor(targetPriceCents - 1, unitCostCents, variableFeeBps, discountBps, configuredTarget)) targetPriceCents--;

  if (targetPriceCents <= input.currentListingPriceCents) {
    return { action: "already_protected", realizedProfitCents, realizedMarginBps, targetPriceCents };
  }
  return { action: "reprice", realizedProfitCents, realizedMarginBps, targetPriceCents };
}
