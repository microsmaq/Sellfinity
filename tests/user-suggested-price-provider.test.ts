import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("user suggested-price provider boundary", () => {
  it("uses the shared catalog fallback without calling Rainforest directly", () => {
    const source = readFileSync(
      new URL("../src/lib/actions/ebay-listings.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export async function cleanupEbayListings");
    const end = source.indexOf("export type SourceCleanupBatchResult", start);
    const action = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(action).toContain("getAdminAmazonSourceWithFallback");
    expect(action).not.toContain("resolveExactAmazonVariant(");
    expect(action).not.toContain("rainforestRequest(");
    expect(action).not.toContain("getScraper(");
  });

  it("uses the same one-time shared fallback for target-profit repricing", () => {
    const source = readFileSync(
      new URL("../src/lib/actions/ebay-listings.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export async function applyTargetProfitPrice");
    const end = source.indexOf("export type EnhanceListingResult", start);
    const action = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(action).toContain("getAdminAmazonSourceWithFallback");
    expect(action).not.toContain("resolveExactAmazonVariant(");
    expect(action).not.toContain("rainforestRequest(");
    expect(action).not.toContain("getScraper(");
  });
});
