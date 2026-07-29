import { describe, expect, it } from "vitest";
import { assessPriceCompetitiveness } from "@/lib/arbitrage/price-competitiveness";

describe("arbitrage price competitiveness", () => {
  it("identifies a suggested price at or below every benchmark", () => {
    expect(assessPriceCompetitiveness(1_500, 1_600, 1_800, 1_700)).toEqual({
      label: "Highly competitive",
      tone: "green",
      summary: "6% below eBay item · 17% below competitor avg · 12% below eBay recommended",
    });
  });

  it("rates prices between the lowest benchmark and the market median", () => {
    expect(assessPriceCompetitiveness(1_700, 1_600, 1_800, 2_000)).toMatchObject({
      label: "Competitive",
      tone: "indigo",
    });
  });

  it("distinguishes near-market, above-market, and high-premium prices", () => {
    expect(assessPriceCompetitiveness(1_850, 1_600, 1_800, 2_000).label).toBe("Near market");
    expect(assessPriceCompetitiveness(2_000, 1_600, 1_800, 2_200).label).toBe("Above market");
    expect(assessPriceCompetitiveness(2_200, 1_600, 1_800, 2_000).label).toBe("High premium");
  });

  it("uses the available benchmarks and explains missing-market cases", () => {
    expect(assessPriceCompetitiveness(1_600, 1_600, null, null)).toMatchObject({
      label: "Highly competitive",
      summary: "matches eBay item",
    });
    expect(assessPriceCompetitiveness(1_600, 0, null, null)).toEqual({
      label: "Not rated",
      tone: "slate",
      summary: "No valid eBay benchmark is available.",
    });
  });
});
