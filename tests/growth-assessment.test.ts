import { describe, expect, it } from "vitest";
import { assessProductGrowth } from "@/lib/analytics/growth-assessment";

describe("product growth assessment", () => {
  it("prioritizes traffic, clicks, conversion, and pricing when metrics are weak", () => {
    const result = assessProductGrowth({
      activeListings: 1,
      impressions: 80,
      views: 1,
      clickThroughRate: 1.25,
      salesConversionRate: 0,
      currentPriceCents: 12999,
      averageCompetitorPriceCents: 9999,
      suggestedPriceCents: 10499,
      sourceMatchConfidence: 95,
    });
    expect(result.label).toBe("Needs attention");
    expect(result.suggestions.map((suggestion) => suggestion.area)).toEqual(
      expect.arrayContaining(["Traffic", "Clicks", "Conversion", "Pricing"]),
    );
  });

  it("recognizes a healthy listing and gives a scaling opportunity", () => {
    const result = assessProductGrowth({
      activeListings: 1,
      impressions: 2000,
      views: 120,
      clickThroughRate: 6,
      salesConversionRate: 5,
      currentPriceCents: 9999,
      averageCompetitorPriceCents: 10199,
      suggestedPriceCents: 9999,
      sourceMatchConfidence: 98,
    });
    expect(result.label).toBe("Healthy");
    expect(result.suggestions[0].title).toBe("Scale what is working");
  });
});
