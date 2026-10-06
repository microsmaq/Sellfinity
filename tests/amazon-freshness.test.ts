import { describe, expect, it } from "vitest";
import { AMAZON_FRESHNESS_WINDOW_MS, isAmazonDataFresh, shouldSkipRecentlyCheckedAmazon } from "../src/lib/amazon/freshness";

describe("Amazon data freshness", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");

  it("treats data within 24 hours as fresh", () => {
    expect(isAmazonDataFresh(new Date(now - AMAZON_FRESHNESS_WINDOW_MS + 1), now)).toBe(true);
  });

  it("treats older or missing data as stale", () => {
    expect(isAmazonDataFresh(new Date(now - AMAZON_FRESHNESS_WINDOW_MS - 1), now)).toBe(false);
    expect(isAmazonDataFresh(null, now)).toBe(false);
  });

  it("always skips fresh data on scheduled runs regardless of the manual checkbox", () => {
    expect(shouldSkipRecentlyCheckedAmazon(true, false)).toBe(true);
    expect(shouldSkipRecentlyCheckedAmazon(true, true)).toBe(true);
  });

  it("keeps the manual freshness override", () => {
    expect(shouldSkipRecentlyCheckedAmazon(false, false)).toBe(false);
    expect(shouldSkipRecentlyCheckedAmazon(false, true)).toBe(true);
  });

  it("skips records at the 24-hour boundary but still checks missing and invalid timestamps", () => {
    expect(isAmazonDataFresh(new Date(now - AMAZON_FRESHNESS_WINDOW_MS), now)).toBe(true);
    expect(isAmazonDataFresh("invalid", now)).toBe(false);
    expect(isAmazonDataFresh(undefined, now)).toBe(false);
  });
});
