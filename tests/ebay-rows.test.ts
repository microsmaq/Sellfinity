import { describe, expect, it } from "vitest";
import { buildEbayRows, type LocalListingFacts } from "@/lib/listings/ebay-rows";
import type { RemoteListing } from "@/lib/ebay/client";

function remote(id: string, priceCents = 2000): RemoteListing {
  return {
    ebayListingId: id,
    title: `Remote listing ${id} with a long enough title`,
    priceCents,
    url: `https://www.ebay.com/itm/${id}`,
    imageUrl: "https://i.ebayimg.com/x.jpg",
    quantity: 3,
  };
}

function local(
  id: string,
  overrides: Partial<{ status: string; costCents: number; supplierStock: number }> = {},
): LocalListingFacts {
  return {
    ebayListingId: id,
    status: overrides.status ?? "ACTIVE",
    sourceMatchVerdict: "MATCH",
    sourceMatchConfidence: 92,
    sourceMatchReason: "Strong product identity evidence.",
    sourceMatchMethod: "RULES",
    imageUrlsJson: "[]",
    publishedAt: new Date("2026-06-15T10:00:00.000Z"),
    product: {
      sku: `SKU-${id}`,
      costCents: overrides.costCents ?? 800,
      shippingCostCents: 0,
      supplierStock: overrides.supplierStock ?? 50,
      supplierUrl: "https://www.amazon.com/dp/X",
    },
  };
}

describe("buildEbayRows", () => {
  it("hides listings the app already ended, even if eBay's list still has them", () => {
    const rows = buildEbayRows(
      [remote("1"), remote("2")],
      [local("1", { status: "ENDED" }), local("2")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ebayListingId).toBe("2");
  });

  it("marks untracked listings as unmatched", () => {
    const rows = buildEbayRows([remote("9")], []);
    expect(rows[0].match).toBeNull();
  });

  it("uses eBay's listing date and falls back to the tracked publication date", () => {
    const ebayDated = remote("1");
    ebayDated.listingDate = new Date("2026-07-01T08:00:00.000Z");
    const rows = buildEbayRows([ebayDated, remote("2")], [local("1"), local("2")]);
    expect(rows.find((row) => row.ebayListingId === "1")?.listingDate).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(rows.find((row) => row.ebayListingId === "2")?.listingDate).toBe(
      "2026-06-15T10:00:00.000Z",
    );
  });

  it("does not show stale profitability before exact-variant verification", () => {
    const tracked = local("9");
    tracked.sourceMatchVerdict = "UNVERIFIED";
    const row = buildEbayRows([remote("9")], [tracked])[0];
    expect(row.match).toBeNull();
    expect(row.suggestedPriceCents).toBeNull();
  });

  it("keeps uncertain sources visible with confidence for seller review", () => {
    const tracked = local("9");
    tracked.sourceMatchVerdict = "REVIEW";
    tracked.sourceMatchConfidence = 74;
    tracked.sourceMatchReason = "Exact child variant is not proven.";
    const row = buildEbayRows([remote("9")], [tracked])[0];
    expect(row.match).toBeNull();
    expect(row.sourceAssessment).toMatchObject({
      verdict: "REVIEW",
      confidence: 74,
      amazonUrl: "https://www.amazon.com/dp/X",
    });
  });

  it("deduplicates listings repeated across eBay pagination boundaries", () => {
    const rows = buildEbayRows(
      [remote("1"), remote("2"), remote("1")],
      [local("1"), local("2")],
    );
    expect(rows.map((row) => row.ebayListingId).sort()).toEqual(["1", "2"]);
  });

  it("hides listings the seller explicitly ended through Sellfinity", () => {
    const rows = buildEbayRows(
      [remote("1"), remote("2")],
      [local("1"), local("2")],
      new Set(["1"]),
    );
    expect(rows.map((row) => row.ebayListingId)).toEqual(["2"]);
  });

  it("computes margin from the tracked product and flags problems first", () => {
    const rows = buildEbayRows(
      [
        remote("ok", 5000),
        remote("loss", 900), // fee + $8 cost > $9 price → unprofitable
        remote("gone", 5000),
        remote("untracked", 5000),
      ],
      [
        local("ok"),
        local("loss"),
        local("gone", { supplierStock: 0 }),
      ],
    );
    expect(rows.map((r) => r.ebayListingId)).toEqual([
      "gone", // unavailable first
      "loss", // then unprofitable
      "untracked", // then unmatched
      "ok",
    ]);
    const ok = rows.find((r) => r.ebayListingId === "ok")!;
    expect(ok.match!.profitCents).toBeGreaterThan(0);
    expect(ok.match!.unavailable).toBe(false);
  });
});
