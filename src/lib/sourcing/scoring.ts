import {
  EBAY_FINAL_VALUE_RATE,
  EBAY_PER_ORDER_FEE_CENTS,
  estimateMargin,
  type MarginEstimate,
} from "@/lib/fees";
import type { SourcingCandidate } from "./provider";

export type ScoredCandidate = SourcingCandidate & {
  margin: MarginEstimate;
  /** 0-100 composite of margin, demand, and competition. */
  score: number;
};

// Normalization ceilings: values at or above these earn a full sub-score.
const MARGIN_PCT_CEILING = 40; // a 40% margin is as good as it gets in resale
const SALES_PER_WEEK_CEILING = 60;
const COMPETITOR_FLOOR_BEST = 5; // ≤5 competitors = wide-open niche

const WEIGHTS = { margin: 0.4, demand: 0.35, competition: 0.25 };

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function scoreCandidate(c: SourcingCandidate): ScoredCandidate {
  const margin = estimateMargin(c.marketPriceCents, c.costCents, c.shippingCostCents);

  const marginScore = clamp01(margin.marginPct / MARGIN_PCT_CEILING);
  const demandScore = clamp01(c.salesPerWeek / SALES_PER_WEEK_CEILING);
  // 1.0 at ≤5 competitors, falling to 0 at 65+.
  const competitionScore = clamp01(1 - (c.competitorCount - COMPETITOR_FLOOR_BEST) / 60);

  // Unprofitable products are never "winners" regardless of demand.
  const score =
    margin.estimatedProfitCents <= 0
      ? Math.round(marginScore * 10)
      : Math.round(
          (marginScore * WEIGHTS.margin +
            demandScore * WEIGHTS.demand +
            competitionScore * WEIGHTS.competition) *
            100,
        );

  return { ...c, margin, score };
}

export function scoreAndRank(candidates: SourcingCandidate[]): ScoredCandidate[] {
  return candidates.map(scoreCandidate).sort((a, b) => b.score - a.score);
}

/**
 * Suggested list price: the nearest .99 charm price at or below ~3% under
 * the market median (always strictly below market), never below what it
 * takes to keep a positive margin.
 */
export function suggestPriceCents(c: {
  marketPriceCents: number;
  costCents: number;
  shippingCostCents: number;
}): number {
  const undercut = c.marketPriceCents * 0.97;
  let charm = Math.round(undercut / 100) * 100 - 1;
  if (charm >= c.marketPriceCents) charm -= 100;
  charm = Math.max(99, charm);
  // Floor: cost + shipping + fees + $1 minimum profit, so autopricing can't
  // suggest selling at a loss.
  const breakEvenFloor = Math.ceil(
    (c.costCents + c.shippingCostCents + EBAY_PER_ORDER_FEE_CENTS + 100) /
      (1 - EBAY_FINAL_VALUE_RATE),
  );
  return Math.max(charm, breakEvenFloor);
}
