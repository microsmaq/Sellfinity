import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("user suggested-price provider boundary", () => {
  it("uses the admin catalog and never invokes a paid Amazon lookup", () => {
    const source = readFileSync(
      new URL("../src/lib/actions/ebay-listings.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export async function cleanupEbayListings");
    const end = source.indexOf("export type SourceCleanupBatchResult", start);
    const action = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(action).toContain("db.adminArbitrageProduct.findUnique");
    expect(action).not.toContain("resolveExactAmazonVariant(");
    expect(action).not.toContain("rainforestRequest(");
    expect(action).not.toContain("getScraper(");
  });

  it("keeps target-profit repricing on the admin catalog too", () => {
    const source = readFileSync(
      new URL("../src/lib/actions/ebay-listings.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export async function applyTargetProfitPrice");
    const end = source.indexOf("export type EnhanceListingResult", start);
    const action = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(action).toContain("db.adminArbitrageProduct.findUnique");
    expect(action).not.toContain("resolveExactAmazonVariant(");
    expect(action).not.toContain("rainforestRequest(");
    expect(action).not.toContain("getScraper(");
  });
});
