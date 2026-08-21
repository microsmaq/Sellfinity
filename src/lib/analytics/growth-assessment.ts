export type GrowthSuggestion = {
  area: "Traffic" | "Clicks" | "Conversion" | "Pricing" | "Listing quality";
  priority: "High" | "Medium" | "Opportunity";
  title: string;
  detail: string;
};

export type ProductGrowthAssessment = {
  score: number;
  label: "Strong" | "Healthy" | "Needs attention" | "Insufficient data";
  summary: string;
  suggestions: GrowthSuggestion[];
};

export function assessProductGrowth(input: {
  activeListings: number;
  impressions: number | null;
  views: number | null;
  clickThroughRate: number | null;
  salesConversionRate: number | null;
  currentPriceCents: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number | null;
  sourceMatchConfidence: number | null;
}): ProductGrowthAssessment {
  if (input.activeListings === 0) {
    return { score: 0, label: "Insufficient data", summary: "No active listing is currently generating buyer traffic.", suggestions: [{ area: "Traffic", priority: "High", title: "Publish or reactivate the listing", detail: "Traffic and conversion optimization starts once an eBay listing is active." }] };
  }
  const suggestions: GrowthSuggestion[] = [];
  let score = 70;
  const impressionsPerListing = (input.impressions ?? 0) / Math.max(1, input.activeListings);
  if (input.impressions === null) {
    score -= 15;
    suggestions.push({ area: "Traffic", priority: "High", title: "Restore traffic reporting", detail: "Reconnect eBay analytics access so impressions, clicks, and conversion can guide decisions." });
  } else if (impressionsPerListing < 150) {
    score -= 20;
    suggestions.push({ area: "Traffic", priority: "High", title: "Increase search visibility", detail: "Strengthen the first 80 characters of the title with buyer keywords, complete item specifics, and review promoted-listing coverage." });
  }
  if (input.clickThroughRate !== null && input.clickThroughRate < 2) {
    score -= 18;
    suggestions.push({ area: "Clicks", priority: "High", title: "Improve the search-result offer", detail: "Test a cleaner main image and a more specific title. Low CTR means buyers see the listing but choose another result." });
  } else if (input.clickThroughRate !== null && input.clickThroughRate < 4) {
    score -= 8;
    suggestions.push({ area: "Clicks", priority: "Medium", title: "Lift click-through rate", detail: "Tighten the title and make the hero image easier to understand at thumbnail size." });
  }
  if (input.salesConversionRate !== null && input.salesConversionRate < 2) {
    score -= 20;
    suggestions.push({ area: "Conversion", priority: "High", title: "Turn more clicks into sales", detail: "Review price, delivery promise, returns, item specifics, and description clarity. Traffic is arriving but not converting." });
  } else if (input.salesConversionRate !== null && input.salesConversionRate < 4) {
    score -= 8;
    suggestions.push({ area: "Conversion", priority: "Medium", title: "Strengthen buyer confidence", detail: "Clarify compatibility, included items, condition, shipping speed, and returns near the top of the listing." });
  }
  if (input.currentPriceCents && input.averageCompetitorPriceCents) {
    const premium = (input.currentPriceCents - input.averageCompetitorPriceCents) / input.averageCompetitorPriceCents;
    if (premium > 0.08) {
      score -= 15;
      suggestions.push({ area: "Pricing", priority: "High", title: "Close the market-price gap", detail: `Your price is ${Math.round(premium * 100)}% above the competitor average. Test the suggested price while protecting your margin.` });
    } else if (premium < -0.15) {
      suggestions.push({ area: "Pricing", priority: "Opportunity", title: "Test a higher price", detail: `Your price is ${Math.round(Math.abs(premium) * 100)}% below the competitor average, leaving room to improve profit without losing competitiveness.` });
    }
  }
  if (input.sourceMatchConfidence !== null && input.sourceMatchConfidence < 90) {
    score -= 8;
    suggestions.push({ area: "Listing quality", priority: "Medium", title: "Verify the exact product variant", detail: "Confirm model, size, color, quantity, and included accessories before scaling traffic." });
  }
  if (suggestions.length === 0) suggestions.push({ area: "Traffic", priority: "Opportunity", title: "Scale what is working", detail: "Traffic, pricing, and conversion are healthy. Increase exposure gradually and monitor profit per order." });
  score = Math.max(0, Math.min(100, score));
  const label = score >= 82 ? "Strong" : score >= 65 ? "Healthy" : "Needs attention";
  return {
    score,
    label,
    summary: label === "Strong" ? "The listing is well positioned to scale." : label === "Healthy" ? "The product has a solid base with clear optimization opportunities." : "Traffic or conversion constraints are limiting sales potential.",
    suggestions: suggestions.slice(0, 5),
  };
}
