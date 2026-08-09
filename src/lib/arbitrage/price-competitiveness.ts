import { discountedEbayPriceCents, normalizeSitewideDiscountBps } from "@/lib/fees";

export type PriceCompetitiveness = {
  label: "Highly competitive" | "Competitive" | "Near market" | "Above market" | "High premium" | "Not rated";
  tone: "green" | "indigo" | "amber" | "red" | "slate";
  summary: string;
};

export function isCompetitivelyPriced(
  assessment: PriceCompetitiveness,
): boolean {
  return assessment.label === "Highly competitive" ||
    assessment.label === "Competitive";
}

type MarketPrice = {
  label: string;
  cents: number | null | undefined;
};

function validMarketPrices(prices: MarketPrice[]): MarketPrice[] {
  return prices.filter(
    (price): price is MarketPrice & { cents: number } =>
      price.cents !== null && price.cents !== undefined && price.cents > 0,
  );
}

function comparison(priceCents: number, market: MarketPrice): string {
  const differencePct = ((priceCents - market.cents!) / market.cents!) * 100;
  const roundedDifference = Math.round(Math.abs(differencePct));

  if (roundedDifference === 0) return `matches ${market.label}`;
  return `${roundedDifference}% ${differencePct < 0 ? "below" : "above"} ${market.label}`;
}

/**
 * Rates the suggested listing price against every available eBay benchmark.
 * The median keeps one unusually cheap listing from making a market-level
 * price look expensive, while the lowest benchmark identifies clear leaders.
 */
export function assessPriceCompetitiveness(
  priceCents: number,
  ebayPriceCents: number,
  averageCompetitorPriceCents?: number | null,
  ebayRecommendedPriceCents?: number | null,
  aiSuggestedPriceCents?: number | null,
  sitewideDiscountBps = 0,
): PriceCompetitiveness {
  const discountBps = normalizeSitewideDiscountBps(sitewideDiscountBps);
  const assessedPriceCents = discountedEbayPriceCents(priceCents, discountBps);
  const prices = validMarketPrices([
    { label: "eBay item", cents: ebayPriceCents },
    { label: "competitor avg", cents: averageCompetitorPriceCents },
    { label: "eBay recommended", cents: ebayRecommendedPriceCents },
    { label: "AI suggested", cents: aiSuggestedPriceCents },
  ]);

  if (assessedPriceCents <= 0 || prices.length === 0) {
    return {
      label: "Not rated",
      tone: "slate",
      summary: "No valid eBay benchmark is available.",
    };
  }

  const sortedPrices = prices.map((price) => price.cents!).sort((a, b) => a - b);
  const lowest = sortedPrices[0];
  const middle = Math.floor(sortedPrices.length / 2);
  const median = sortedPrices.length % 2 === 0
    ? (sortedPrices[middle - 1] + sortedPrices[middle]) / 2
    : sortedPrices[middle];
  const premiumToMedian = ((assessedPriceCents - median) / median) * 100;

  let rating: Pick<PriceCompetitiveness, "label" | "tone">;
  if (assessedPriceCents <= lowest) {
    rating = { label: "Highly competitive", tone: "green" };
  } else if (assessedPriceCents <= median) {
    rating = { label: "Competitive", tone: "indigo" };
  } else if (premiumToMedian <= 5) {
    rating = { label: "Near market", tone: "indigo" };
  } else if (premiumToMedian <= 15) {
    rating = { label: "Above market", tone: "amber" };
  } else {
    rating = { label: "High premium", tone: "red" };
  }

  return {
    ...rating,
    summary: [
      ...(discountBps > 0
        ? [`${(discountBps / 100).toFixed(2).replace(/\.00$/, "")}% sitewide discount → $${(assessedPriceCents / 100).toFixed(2)} buyer price`]
        : []),
      ...prices.map((market) => comparison(assessedPriceCents, market)),
    ].join(" · "),
  };
}
