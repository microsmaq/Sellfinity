import { describe, expect, it } from "vitest";
import { MockEbayClient } from "@/lib/ebay/mock";
import { EBAY_SCOPES } from "@/lib/ebay/oauth";

describe("ASIN traffic analytics", () => {
  it("returns deterministic traffic without fabricating missing listing ids", async () => {
    const client = new MockEbayClient();
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-31T00:00:00Z");
    const first = await client.getListingTraffic("user-1", ["123", "456"], start, end);
    const second = await client.getListingTraffic("user-1", ["123", "456"], start, end);
    expect(first).toEqual(second);
    expect(first.map((row) => row.ebayListingId)).toEqual(["123", "456"]);
    expect(first.every((row) => (row.impressions ?? 0) >= (row.views ?? 0))).toBe(true);
  });

  it("requests only read access for seller analytics", () => {
    expect(EBAY_SCOPES).toContain(
      "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
    );
  });
});
