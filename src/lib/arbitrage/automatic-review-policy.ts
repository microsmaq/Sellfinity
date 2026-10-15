import type { ProductMatchAssessment } from "./product-match";

type ReviewFacts = {
  assessment: ProductMatchAssessment;
  rulesRejected: boolean;
  amazonTitle: string;
  ebayTitle: string;
  brand: string;
  variant: string;
  amazonImage: string | null;
  ebayImage: string | null;
};

const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** New research requires exact title evidence. Saved candidates may instead use
 * visual AI plus a separate image-aware Decisions check to resolve omissions. */
export function automaticReviewDecision(facts: ReviewFacts, minimumConfidence = 100, allowTitleOmissions = false): { publish: boolean; reason: string } {
  const hold = (reason: string) => ({ publish: false, reason });
  if (facts.assessment.verdict !== "MATCH" || facts.assessment.confidence < minimumConfidence || facts.rulesRejected) return hold(`Current verification: ${facts.assessment.verdict} at ${facts.assessment.confidence}%. Automatic approval requires MATCH at ${minimumConfidence}% or higher with no rule conflict. ${facts.assessment.reason}`);
  if (!facts.amazonImage || !facts.ebayImage) return hold("Both product images are required for identity review.");
  if (allowTitleOmissions && facts.assessment.method === "AI") return { publish: true, reason: `Image-aware product match verified at ${facts.assessment.confidence}%. Decisions must independently confirm identity and check for explicit conflicts. Profitability and listing decisions belong to each seller.` };
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
  return { publish: true, reason: `Automatic product match verified: exact brand and variant evidence, MATCH ${facts.assessment.confidence}%. Profitability and listing decisions belong to each seller.` };
}
