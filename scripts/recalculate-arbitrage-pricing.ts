import { db } from "../src/lib/db";
import { arbitrageSuggestedPriceCents } from "../src/lib/arbitrage/pricing";
import { estimateMargin } from "../src/lib/fees";

async function main() {
  const catalog = await db.adminArbitrageProduct.findMany({
    where: { ebayPriceCents: { not: null } },
  });
  const research = await db.arbitrageItem.findMany();
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

  console.log(JSON.stringify({ catalogUpdated, researchUpdated }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
