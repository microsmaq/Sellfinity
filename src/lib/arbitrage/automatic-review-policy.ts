import type { ProductMatchAssessment } from "./product-match";
import { assessPriceCompetitiveness, isCompetitivelyPriced } from "./price-competitiveness";
import { AUTO_PUBLISH_MIN_MARGIN_PCT, AUTO_PUBLISH_FLAT_PROFIT_CENTS } from "./auto-publish";

type ReviewFacts = {
  assessment: ProductMatchAssessment;
  rulesRejected: boolean;
  amazonTitle: string;
  ebayTitle: string;
  brand: string;
  variant: string;
  amazonImage: string | null;
  ebayImage: string | null;
  inStock: boolean;
  shippingVerified: boolean;
  amazonCheckedAt: Date | null;
  suggestedPriceCents: number;
  ebayPriceCents: number;
  averagePriceCents: number | null;
  profitCents: number;
  marginPct: number;
  hasMarketEvidence: boolean;
};

const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** AI certainty is one input, not a substitute for observable identity and
 * landed-cost checks. Missing variant evidence stays in manual review. */
export function automaticReviewDecision(facts: ReviewFacts, now = new Date()): { publish: boolean; reason: string } {
  const hold = (reason: string) => ({ publish: false, reason });
  if (!facts.inStock || !facts.shippingVerified) return hold("Amazon availability or shipping needs verification.");
  if (!facts.amazonCheckedAt || now.getTime() - facts.amazonCheckedAt.getTime() > 24 * 60 * 60 * 1000) return hold("Amazon data is older than 24 hours; refresh it first.");
  if (facts.assessment.verdict !== "MATCH" || facts.assessment.confidence !== 100 || facts.rulesRejected) return hold("Match needs administrator review; automatic publication requires MATCH at 100% with no rule conflict.");
  if (!facts.amazonImage || !facts.ebayImage) return hold("Both product images are required for identity review.");
  const ebay = new Set(tokens(facts.ebayTitle));
  const brand = tokens(facts.brand);
  if (!brand.length || brand.some((token) => !ebay.has(token))) return hold("The exact Amazon brand is not confirmed in the eBay title.");
  const variant = tokens(facts.variant).filter((token) => !["color", "size", "style"].includes(token));
  if (variant.some((token) => !ebay.has(token))) return hold("The selected variant is not confirmed in the eBay title.");
  const quantities = /\b\d+\s*(?:pack|pk|count|ct|pcs?|pieces?|units?)\b/gi;
  const sizes = /\b\d+(?:\.\d+)?\s*(?:inch(?:es)?|in|feet|ft|cm|mm|oz|ounces?|lb|lbs|ml|liters?|w|watts?)\b/gi;
  const models = /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)*\b/gi;
  const normalized = (value: string) => value.toLowerCase().replace(/[\s-]/g, "");
  for (const pattern of [quantities, sizes, models]) {
    const amazonAttributes = (facts.amazonTitle.match(pattern) ?? []).map(normalized);
    const ebayAttributes = new Set((facts.ebayTitle.match(pattern) ?? []).map(normalized));
    if (amazonAttributes.some((value) => !ebayAttributes.has(value))) return hold("A model, pack quantity or size is missing or differs in the eBay title.");
  }
  if (!facts.hasMarketEvidence || !facts.averagePriceCents) return hold("Current eBay market evidence is unavailable.");
  if (facts.profitCents <= 0 || (facts.marginPct < AUTO_PUBLISH_MIN_MARGIN_PCT && facts.profitCents < AUTO_PUBLISH_FLAT_PROFIT_CENTS)) return hold("The product does not meet the automatic profit threshold.");
  if (!isCompetitivelyPriced(assessPriceCompetitiveness(facts.suggestedPriceCents, facts.ebayPriceCents, facts.averagePriceCents))) return hold("The profitable suggested price is not competitive with the eBay market.");
  return { publish: true, reason: "Automatic review passed: exact brand and variant evidence, MATCH 100%, verified fresh landed cost, competitive profitable pricing." };
}
