import { describe, expect, it } from "vitest";
import {
  AUTO_PUBLISH_FLAT_PROFIT_CENTS,
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
  isAutoPublishCandidate,
} from "@/lib/arbitrage/auto-publish";
import {
  AUTO_PUBLISH_AMAZON_MAX_AGE_MS,
  hasFreshAmazonSnapshot,
} from "@/lib/arbitrage/amazon-refresh-policy";

describe("arbitrage automatic publishing safety gate", () => {
  const qualified = {
    matchVerdict: "MATCH",
    matchConfidence: AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
    marginPct: AUTO_PUBLISH_MIN_MARGIN_PCT,
    profitCents: 1,
  };

  it("accepts a profitable match at both thresholds", () => {
    expect(isAutoPublishCandidate(qualified)).toBe(true);
    expect(isAutoPublishCandidate({ ...qualified, matchVerdict: "LIKELY" })).toBe(true);
  });

  it("accepts the flat-profit rule for higher-cost products", () => {
    expect(isAutoPublishCandidate({
      ...qualified,
      marginPct: 10,
      profitCents: AUTO_PUBLISH_FLAT_PROFIT_CENTS,
    })).toBe(true);
  });

  it("rejects weak identity, low margin, and non-positive profit", () => {
    expect(isAutoPublishCandidate({ ...qualified, matchConfidence: 94 })).toBe(false);
    expect(isAutoPublishCandidate({
      ...qualified,
      marginPct: 14,
      profitCents: AUTO_PUBLISH_FLAT_PROFIT_CENTS - 1,
    })).toBe(false);
    expect(isAutoPublishCandidate({ ...qualified, profitCents: 0 })).toBe(false);
    expect(isAutoPublishCandidate({ ...qualified, matchVerdict: "REVIEW" })).toBe(false);
  });

  it("requires an available Amazon snapshot no older than six hours", () => {
    const now = new Date("2026-08-04T10:00:00.000Z");
    expect(hasFreshAmazonSnapshot(now, true, now)).toBe(true);
    expect(hasFreshAmazonSnapshot(
      new Date(now.getTime() - AUTO_PUBLISH_AMAZON_MAX_AGE_MS),
      true,
      now,
    )).toBe(true);
    expect(hasFreshAmazonSnapshot(
      new Date(now.getTime() - AUTO_PUBLISH_AMAZON_MAX_AGE_MS - 1),
      true,
      now,
    )).toBe(false);
    expect(hasFreshAmazonSnapshot(now, false, now)).toBe(false);
    expect(hasFreshAmazonSnapshot(null, true, now)).toBe(false);
  });
});
