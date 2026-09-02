import { describe, expect, it } from "vitest";
import { AMAZON_FRESHNESS_WINDOW_MS, isAmazonDataFresh } from "../src/lib/amazon/freshness";

describe("Amazon data freshness", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");

  it("treats data within 24 hours as fresh", () => {
    expect(isAmazonDataFresh(new Date(now - AMAZON_FRESHNESS_WINDOW_MS + 1), now)).toBe(true);
  });

  it("treats older or missing data as stale", () => {
    expect(isAmazonDataFresh(new Date(now - AMAZON_FRESHNESS_WINDOW_MS - 1), now)).toBe(false);
    expect(isAmazonDataFresh(null, now)).toBe(false);
  });
});
