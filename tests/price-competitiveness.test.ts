import { describe, expect, it } from "vitest";
import {
  assessPriceCompetitiveness,
  isCompetitivelyPriced,
} from "@/lib/arbitrage/price-competitiveness";

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

  it("only qualifies highly competitive and competitive prices", () => {
    const labels = [
      [1_500, true],
      [1_700, true],
      [1_850, false],
      [2_000, false],
      [2_200, false],
    ] as const;

    for (const [suggestedPrice, expected] of labels) {
      expect(isCompetitivelyPriced(
        assessPriceCompetitiveness(suggestedPrice, 1_600, 1_800, 2_000),
      )).toBe(expected);
    }
  });

  it("can rate a live listing price against the AI suggested price too", () => {
    expect(assessPriceCompetitiveness(1_750, 1_750, 1_800, 1_700, 1_650)).toMatchObject({
      label: "Near market",
      summary: "matches eBay item · 3% below competitor avg · 3% above eBay recommended · 6% above AI suggested",
    });
  });

  it("assesses the buyer price after a seller sitewide discount", () => {
    expect(
      assessPriceCompetitiveness(2_000, 2_000, 1_850, 1_800, null, 500),
    ).toEqual({
      label: "Near market",
      tone: "indigo",
      summary: "5% sitewide discount → $19.00 buyer price · 5% below eBay item · 3% above competitor avg · 6% above eBay recommended",
    });
  });
});
