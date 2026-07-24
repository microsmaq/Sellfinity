import { describe, expect, it } from "vitest";
import { shouldBlockRainforestOverage } from "@/lib/mirror/rainforest";

describe("Rainforest overage limit", () => {
  it("never blocks while included credits remain", () => {
    expect(shouldBlockRainforestOverage(1, 300)).toBe(false);
    expect(shouldBlockRainforestOverage(32, 2_000)).toBe(false);
  });

  it("allows overage through request 299 and blocks at 300", () => {
    expect(shouldBlockRainforestOverage(0, 299)).toBe(false);
    expect(shouldBlockRainforestOverage(0, 300)).toBe(true);
    expect(shouldBlockRainforestOverage(-10, 301)).toBe(true);
  });

  it("does not block when account usage is unavailable", () => {
    expect(shouldBlockRainforestOverage(null, 1_000)).toBe(false);
  });
});
