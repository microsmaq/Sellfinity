import { describe, expect, it } from "vitest";
import { shouldBlockRainforestOverage } from "@/lib/mirror/rainforest";

describe("Rainforest overage limit", () => {
  it("never blocks while included credits remain", () => {
    expect(shouldBlockRainforestOverage(1, 300, 300)).toBe(false);
    expect(shouldBlockRainforestOverage(32, 2_000, 300)).toBe(false);
  });

  it("does not block overage when no daily limit is configured", () => {
    expect(shouldBlockRainforestOverage(0, 300, null)).toBe(false);
    expect(shouldBlockRainforestOverage(-10, 10_000, null)).toBe(false);
  });

  it("can restore an optional positive daily limit later", () => {
    expect(shouldBlockRainforestOverage(0, 299, 300)).toBe(false);
    expect(shouldBlockRainforestOverage(0, 300, 300)).toBe(true);
    expect(shouldBlockRainforestOverage(-10, 301, 300)).toBe(true);
  });

  it("does not block when account usage is unavailable", () => {
    expect(shouldBlockRainforestOverage(null, 1_000, 300)).toBe(false);
  });
});
