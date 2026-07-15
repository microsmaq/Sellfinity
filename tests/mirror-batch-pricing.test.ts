import { describe, expect, it } from "vitest";
import { sourceMarkupPriceCents } from "@/lib/mirror/pipeline";

describe("direct mirror batch pricing", () => {
  it("lists at exactly 30 percent above the Amazon source by default", () => {
    expect(sourceMarkupPriceCents(10_00)).toBe(13_00);
    expect(sourceMarkupPriceCents(9_99)).toBe(12_99);
    expect(sourceMarkupPriceCents(20_00)).toBe(26_00);
  });

  it("still respects eBay's minimum listing price", () => {
    expect(sourceMarkupPriceCents(25)).toBe(99);
  });
});
