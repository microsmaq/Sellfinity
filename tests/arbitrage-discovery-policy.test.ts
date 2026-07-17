import { describe, expect, it } from "vitest";
import {
  balancedCategoryKeywords,
  CATEGORY_KEYWORDS,
} from "@/lib/arbitrage/discovery-policy";

describe("arbitrage discovery category policy", () => {
  it("covers a broad set of resale-friendly categories", () => {
    const categories = new Set(CATEGORY_KEYWORDS.map((entry) => entry.category));
    expect(categories.size).toBeGreaterThanOrEqual(12);
  });

  it("visits every category before repeating one", () => {
    const rotation = balancedCategoryKeywords(20_000);
    const categoryCount = new Set(rotation.map((entry) => entry.category)).size;
    const firstRound = rotation.slice(0, categoryCount).map((entry) => entry.category);
    expect(new Set(firstRound).size).toBe(categoryCount);
  });

  it("retains every keyword while rotating daily priority", () => {
    const today = balancedCategoryKeywords(20_000);
    const tomorrow = balancedCategoryKeywords(20_001);
    expect(new Set(today.map((entry) => entry.keyword))).toEqual(
      new Set(CATEGORY_KEYWORDS.map((entry) => entry.keyword)),
    );
    expect(tomorrow[0].category).not.toBe(today[0].category);
  });
});
