import { db } from "@/lib/db";
import { estimateMargin } from "@/lib/fees";
import { arbitrageSuggestedPriceCents } from "./pricing";

export type ArbitragePricingRecalculation = {
  catalogUpdated: number;
  researchUpdated: number;
};

/** Recalculate stored pricing only. No Amazon, eBay, AI, or other provider
 * calls are made, so this operation consumes no external API credits. */
export async function recalculateAllArbitragePricing(): Promise<ArbitragePricingRecalculation> {
  const [catalog, research] = await Promise.all([
    db.adminArbitrageProduct.findMany({
      where: { ebayPriceCents: { not: null } },
    }),
    db.arbitrageItem.findMany(),
  ]);
  let catalogUpdated = 0;
  let researchUpdated = 0;

  for (let index = 0; index < catalog.length; index += 50) {
    const chunk = catalog.slice(index, index + 50);
    await db.$transaction(
      chunk.map((item) => {
        const suggestedPriceCents = arbitrageSuggestedPriceCents(
          item.amazonPriceCents,
          item.ebayPriceCents ?? 0,
          item.ebayRecommendedPriceCents,
          item.averageCompetitorPriceCents ?? item.ebayPriceCents ?? 0,
          item.amazonShippingCents,
        );
        const margin = estimateMargin(
          suggestedPriceCents,
          item.amazonPriceCents,
          item.amazonShippingCents,
        );
        return db.adminArbitrageProduct.update({
          where: { id: item.id },
          data: {
            suggestedPriceCents,
            estimatedProfitCents: margin.estimatedProfitCents,
            marginPct: Math.round(margin.marginPct),
          },
        });
      }),
    );
    catalogUpdated += chunk.length;
  }

  for (let index = 0; index < research.length; index += 50) {
    const chunk = research.slice(index, index + 50);
    await db.$transaction(
      chunk.map((item) => {
        const suggestedPriceCents = arbitrageSuggestedPriceCents(
          item.amazonPriceCents,
          item.ebayPriceCents,
          item.bestSellingPriceCents,
          item.avgCompPriceCents ?? item.ebayPriceCents,
          item.amazonShippingCents,
        );
        const margin = estimateMargin(
          suggestedPriceCents,
          item.amazonPriceCents,
          item.amazonShippingCents,
        );
        return db.arbitrageItem.update({
          where: { id: item.id },
          data: {
            profitCents: margin.estimatedProfitCents,
            marginPct: Math.round(margin.marginPct),
            feeCents: margin.estimatedFeeCents,
          },
        });
      }),
    );
    researchUpdated += chunk.length;
  }

  return { catalogUpdated, researchUpdated };
}
