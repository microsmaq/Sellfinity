import { db } from "@/lib/db";
import { searchEbayProducts, researchEbayMarket } from "@/lib/ebay/market";
import { estimateMargin } from "@/lib/fees";
import { getScraper } from "@/lib/mirror";
import { extractAsin } from "@/lib/mirror/scraper";
import { sharedAmazonSnapshotData } from "@/lib/mirror/shared-catalog";
import { arbitrageSuggestedPriceCents } from "./pricing";
import {
  assessProductMatch,
  assessProductMatchRules,
  isApprovedProductMatch,
  type ProductMatchAssessment,
} from "./product-match";
import { estimatedSales30d } from "./demand";
import { publishCatalogProductToUsers } from "./admin-catalog";

export async function addAmazonCatalogProduct(input: string): Promise<string> {
  const trimmed = input.trim();
  const url = /^[A-Z0-9]{10}$/i.test(trimmed)
    ? `https://www.amazon.com/dp/${trimmed.toUpperCase()}`
    : trimmed;
  const asin = extractAsin(url);
  if (!asin) throw new Error("Enter an Amazon product URL or a 10-character ASIN.");

  const product = await getScraper().scrape(url);
  if (!product) throw new Error("Amazon did not return a usable product for that URL.");
  if (!product.inStock || product.priceCents <= 0) {
    throw new Error("This Amazon product is unavailable or has no current price.");
  }

  const snapshot = sharedAmazonSnapshotData(product);

  const row = await db.adminArbitrageProduct.upsert({
    where: { asin },
    create: {
      asin,
      ...snapshot,
      // A direct URL is administrator-curated, but is not labeled as a
      // bestseller unless it entered through the bestseller discovery feed.
      isAmazonBestSeller: false,
      status: "PENDING",
    },
    update: {
      ...snapshot,
      status: "PENDING",
    },
  });
  await researchAdminCatalogProduct(row.id);
  return row.id;
}

function rankAssessment(assessment: ProductMatchAssessment): number {
  const verdictWeight = {
    MATCH: 400,
    LIKELY: 300,
    REVIEW: 200,
    REJECTED: 0,
  }[assessment.verdict];
  return verdictWeight + assessment.confidence;
}

export async function researchAdminCatalogProduct(id: string): Promise<void> {
  const item = await db.adminArbitrageProduct.findUnique({ where: { id } });
  if (!item) throw new Error("Catalog item no longer exists.");

  // Refresh Amazon truth first so profitability never uses a stale variant.
  const source = await getScraper().scrape(item.amazonUrl);
  if (!source || !source.inStock || source.priceCents <= 0) {
    await db.adminArbitrageProduct.update({
      where: { id },
      data: {
        amazonInStock: false,
        amazonRefreshedAt: new Date(),
        status: "NO_MATCH",
        matchVerdict: "REJECTED",
        matchConfidence: 100,
        matchReason: "The exact Amazon source is currently unavailable.",
        lastResearchedAt: new Date(),
      },
    });
    return;
  }
  const sourceSnapshot = sharedAmazonSnapshotData(source);

  const candidates = await searchEbayProducts(source.title, 50);
  const attached = candidates.length
    ? await db.adminArbitrageProduct.findMany({
        where: {
          ebayItemId: { in: candidates.map((candidate) => candidate.itemId) },
          id: { not: id },
        },
        select: { ebayItemId: true },
      })
    : [];
  const unavailableIds = new Set(attached.flatMap((row) => row.ebayItemId ?? []));
  const rankedByRules = candidates
    .filter((candidate) => !unavailableIds.has(candidate.itemId))
    .map((candidate) => ({
      candidate,
      rules: assessProductMatchRules(candidate.title, source.title),
    }))
    .filter(({ rules }) => rules.verdict !== "REJECTED")
    .sort((a, b) => rankAssessment(b.rules) - rankAssessment(a.rules))
    .slice(0, 8);

  let best:
    | {
        candidate: (typeof rankedByRules)[number]["candidate"];
        assessment: ProductMatchAssessment;
      }
    | undefined;
  for (const entry of rankedByRules) {
    const assessment = await assessProductMatch(
      {
        title: entry.candidate.title,
        imageUrl: entry.candidate.imageUrl,
      },
      { title: source.title, imageUrl: source.imageUrls[0] },
    );
    if (!best || rankAssessment(assessment) > rankAssessment(best.assessment)) {
      best = { candidate: entry.candidate, assessment };
    }
    if (assessment.verdict === "MATCH" && assessment.confidence >= 95) break;
  }

  if (!best) {
    await db.adminArbitrageProduct.update({
      where: { id },
      data: {
        ...sourceSnapshot,
        status: "NO_MATCH",
        ebayItemId: null,
        ebayTitle: null,
        ebayPriceCents: null,
        ebayUrl: null,
        ebayImageUrl: null,
        matchVerdict: "REJECTED",
        matchConfidence: 90,
        matchReason: "No sufficiently similar eBay product was found.",
        estimatedSales30d: null,
        competitorCount: null,
        averageCompetitorPriceCents: null,
        ebayRecommendedPriceCents: null,
        suggestedPriceCents: null,
        estimatedProfitCents: null,
        marginPct: null,
        lastResearchedAt: new Date(),
      },
    });
    return;
  }

  const market = await researchEbayMarket(
    best.candidate.title,
    best.candidate.itemId,
  );
  const metrics = market?.metrics;
  const averagePrice =
    metrics?.averageCompetitorPriceCents ?? best.candidate.priceCents;
  const recommendedPrice = metrics?.bestSellingPriceCents ?? null;
  const suggestedPrice = arbitrageSuggestedPriceCents(
    source.priceCents,
    best.candidate.priceCents,
    recommendedPrice,
    averagePrice,
    source.shippingCostCents,
  );
  const margin = estimateMargin(
    suggestedPrice,
    source.priceCents,
    source.shippingCostCents,
  );
  const approved = isApprovedProductMatch(best.assessment);

  await db.adminArbitrageProduct.update({
    where: { id },
    data: {
      ...sourceSnapshot,
      category: source.category || best.candidate.category || item.category,
      status: approved ? "PUBLISHED" : "NO_MATCH",
      ebayItemId: best.candidate.itemId,
      ebayTitle: best.candidate.title,
      ebayPriceCents: best.candidate.priceCents,
      ebayUrl: best.candidate.url,
      ebayImageUrl: best.candidate.imageUrl || null,
      matchVerdict: best.assessment.verdict,
      matchConfidence: best.assessment.confidence,
      matchReason: best.assessment.reason,
      estimatedSales30d:
        metrics?.estimatedSales30d ??
        estimatedSales30d(best.candidate.itemId, best.candidate.priceCents),
      competitorCount: metrics?.competitorCount ?? 1,
      averageCompetitorPriceCents: averagePrice,
      ebayRecommendedPriceCents:
        recommendedPrice,
      suggestedPriceCents: suggestedPrice,
      estimatedProfitCents: margin.estimatedProfitCents,
      marginPct: Math.round(margin.marginPct),
      lastResearchedAt: new Date(),
    },
  });

  if (approved) await publishCatalogProductToUsers(id);
}

/** Refresh only Amazon buy-box truth for one curated row. This is the paid
 * Rainforest portion; eBay market data and AI matching are deliberately
 * untouched so one product costs at most one uncached provider request. */
export async function refreshAdminAmazonCost(id: string): Promise<void> {
  const item = await db.adminArbitrageProduct.findUnique({ where: { id } });
  if (!item) throw new Error("Catalog item no longer exists.");
  const source = await getScraper().scrape(item.amazonUrl);
  if (!source || !source.inStock || source.priceCents <= 0) {
    await db.adminArbitrageProduct.update({
      where: { id },
      data: {
        amazonInStock: false,
        amazonRefreshedAt: new Date(),
        status: "NO_MATCH",
        matchVerdict: "REJECTED",
        matchConfidence: 100,
        matchReason: "The exact Amazon source is currently unavailable.",
        lastResearchedAt: new Date(),
      },
    });
    return;
  }
  const sourceSnapshot = sharedAmazonSnapshotData(source);

  const suggestedPrice = item.ebayPriceCents
    ? arbitrageSuggestedPriceCents(
        source.priceCents,
        item.ebayPriceCents,
        item.ebayRecommendedPriceCents,
        item.averageCompetitorPriceCents ?? item.ebayPriceCents,
        source.shippingCostCents,
      )
    : null;
  const margin = suggestedPrice
    ? estimateMargin(
        suggestedPrice,
        source.priceCents,
        source.shippingCostCents,
      )
    : null;
  await db.adminArbitrageProduct.update({
    where: { id },
    data: {
      ...sourceSnapshot,
      ...(suggestedPrice && margin && {
        suggestedPriceCents: suggestedPrice,
        estimatedProfitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
      }),
      lastResearchedAt: new Date(),
    },
  });
  if (item.status === "PUBLISHED") {
    await publishCatalogProductToUsers(id);
  }
}

/** Refresh eBay market metrics without making an Amazon/Rainforest request. */
export async function refreshAdminEbayMarket(id: string): Promise<{
  asin: string;
  matchVerdict: string;
  matchConfidence: number;
  marketFallback: boolean;
}> {
  const item = await db.adminArbitrageProduct.findUnique({ where: { id } });
  if (
    !item ||
    !item.ebayItemId ||
    !item.ebayTitle ||
    !item.ebayPriceCents
  ) {
    throw new Error("This catalog row has no researched eBay equivalent.");
  }
  const [market, assessment] = await Promise.all([
    researchEbayMarket(item.ebayTitle, item.ebayItemId, {
      allowReferenceFallback: true,
    }),
    assessProductMatch(
      { title: item.ebayTitle, imageUrl: item.ebayImageUrl },
      { title: item.amazonTitle, imageUrl: item.amazonImageUrl },
    ),
  ]);
  // An ended or uniquely named reference can legitimately return no live
  // comparable. Preserve a complete, explicitly conservative one-item market
  // snapshot instead of leaving demand/pricing columns empty.
  const metrics = market?.metrics ?? {
    estimatedSales30d: estimatedSales30d(
      item.ebayItemId,
      item.ebayPriceCents,
    ),
    competitorCount: 1,
    averageCompetitorPriceCents: item.ebayPriceCents,
    bestSellingPriceCents: item.ebayPriceCents,
  };
  const ebayPriceCents = market?.referencePriceCents ?? item.ebayPriceCents;
  const suggestedPrice = arbitrageSuggestedPriceCents(
    item.amazonPriceCents,
    ebayPriceCents,
    metrics.bestSellingPriceCents,
    metrics.averageCompetitorPriceCents,
    item.amazonShippingCents,
  );
  const margin = estimateMargin(
    suggestedPrice,
    item.amazonPriceCents,
    item.amazonShippingCents,
  );
  const status =
    assessment.verdict === "REJECTED" ? "NO_MATCH" : "PUBLISHED";
  const researchedAt = new Date();
  await db.adminArbitrageProduct.update({
    where: { id },
    data: {
      status,
      ebayPriceCents,
      matchVerdict: assessment.verdict,
      matchConfidence: assessment.confidence,
      matchReason: assessment.reason,
      estimatedSales30d: metrics.estimatedSales30d,
      competitorCount: metrics.competitorCount,
      averageCompetitorPriceCents: metrics.averageCompetitorPriceCents,
      ebayRecommendedPriceCents: metrics.bestSellingPriceCents,
      suggestedPriceCents: suggestedPrice,
      estimatedProfitCents: margin.estimatedProfitCents,
      marginPct: Math.round(margin.marginPct),
      lastResearchedAt: researchedAt,
    },
  });

  if (status === "PUBLISHED") {
    await publishCatalogProductToUsers(id);
  } else {
    await db.arbitrageItem.updateMany({
      where: { ebayItemId: item.ebayItemId },
      data: {
        salesEst: metrics.estimatedSales30d,
        competitorCount: metrics.competitorCount,
        avgCompPriceCents: metrics.averageCompetitorPriceCents,
        bestSellingPriceCents: metrics.bestSellingPriceCents,
        profitCents: margin.estimatedProfitCents,
        marginPct: Math.round(margin.marginPct),
        feeCents: margin.estimatedFeeCents,
        matchVerdict: assessment.verdict,
        matchConfidence: assessment.confidence,
        matchReason: assessment.reason,
        matchMethod: assessment.method,
        matchCheckedAt: researchedAt,
      },
    });
  }
  return {
    asin: item.asin,
    matchVerdict: assessment.verdict,
    matchConfidence: assessment.confidence,
    marketFallback: !market,
  };
}
