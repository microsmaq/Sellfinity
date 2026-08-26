import {
  DEFAULT_EBAY_AD_RATE_BPS,
  EBAY_FINAL_VALUE_RATE,
  EBAY_PER_ORDER_FEE_CENTS,
  discountedEbayPriceCents,
  normalizeAdRateBps,
} from "@/lib/fees";

export type TargetProfitMode = "FIXED" | "AI_RANGE";

export function normalizeTargetProfitMode(value: string | null | undefined): TargetProfitMode {
  return value === "AI_RANGE" ? "AI_RANGE" : "FIXED";
}

type TargetProfitSettings = {
  targetProfitEnabled: boolean;
  targetProfitMode?: string | null;
  targetProfitMinCents?: number | null;
  targetProfitCents: number;
  ebaySitewideDiscountBps?: number;
  ebayAdRateBps?: number;
};

type ProductPricingContext = {
  amazonCostCents: number;
  amazonShippingCents?: number;
  currentEbayPriceCents?: number | null;
  ebayRecommendedPriceCents?: number | null;
  averageCompetitorPriceCents?: number | null;
};

function positive(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/** Select a per-item target without pricing above the strongest available
 * market anchor. When market data is absent, use a conservative 10% of landed
 * cost so inexpensive products naturally stay near the configured minimum. */
export function resolveTargetProfitCents(
  settings: TargetProfitSettings,
  context: ProductPricingContext,
): number | null {
  if (!settings.targetProfitEnabled) return null;
  const maximum = Math.max(0, Math.round(settings.targetProfitCents));
  if (normalizeTargetProfitMode(settings.targetProfitMode) === "FIXED") return maximum;

  const minimum = Math.min(maximum, Math.max(0, Math.round(settings.targetProfitMinCents ?? 100)));
  const landedCost = Math.max(0, Math.round(context.amazonCostCents))
    + Math.max(0, Math.round(context.amazonShippingCents ?? 0));
  const marketValues = [
    positive(context.ebayRecommendedPriceCents),
    positive(context.averageCompetitorPriceCents),
  ].filter((value): value is number => value !== null);
  const fallbackCurrent = positive(context.currentEbayPriceCents);
  const marketAnchor = marketValues.length ? Math.min(...marketValues) : fallbackCurrent;

  if (marketAnchor !== null) {
    const buyerRevenue = discountedEbayPriceCents(marketAnchor, settings.ebaySitewideDiscountBps ?? 0);
    const variableFees = Math.round(buyerRevenue * EBAY_FINAL_VALUE_RATE)
      + Math.round(buyerRevenue * normalizeAdRateBps(settings.ebayAdRateBps ?? DEFAULT_EBAY_AD_RATE_BPS) / 10_000);
    const competitiveProfit = buyerRevenue - variableFees - EBAY_PER_ORDER_FEE_CENTS - landedCost;
    return Math.max(minimum, Math.min(maximum, competitiveProfit));
  }

  return Math.max(minimum, Math.min(maximum, Math.round(landedCost * 0.1)));
}

export function targetProfitLabel(settings: TargetProfitSettings): string {
  if (!settings.targetProfitEnabled) return "standard profit safeguard";
  if (normalizeTargetProfitMode(settings.targetProfitMode) === "AI_RANGE") {
    return `AI target between $${((settings.targetProfitMinCents ?? 100) / 100).toFixed(2)} and $${(settings.targetProfitCents / 100).toFixed(2)}`;
  }
  return `$${(settings.targetProfitCents / 100).toFixed(2)} target profit`;
}
