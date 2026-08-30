import { describe, expect, it } from "vitest";
import { recentBestSellerSales } from "@/lib/ebay/bestseller-sales-trends";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-08-29T12:00:00.000Z");

describe("eBay bestseller recent sales", () => {
  it("calculates the cumulative sold-count change near the requested window", () => {
    expect(recentBestSellerSales([
      { capturedAt: now - 7 * day, quantitySold: 100 },
      { capturedAt: now, quantitySold: 118 },
    ], now, 7)).toBe(18);
  });

  it("returns unknown when historical coverage is insufficient", () => {
    expect(recentBestSellerSales([
      { capturedAt: now - day, quantitySold: 100 },
      { capturedAt: now, quantitySold: 105 },
    ], now, 7)).toBeNull();
  });

  it("does not report a negative change when eBay resets a sold count", () => {
    expect(recentBestSellerSales([
      { capturedAt: now - 30 * day, quantitySold: 300 },
      { capturedAt: now, quantitySold: 20 },
    ], now, 30)).toBeNull();
  });
});
