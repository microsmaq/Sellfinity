import { describe, expect, it } from "vitest";
import {
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
  isAutoPublishCandidate,
} from "@/lib/arbitrage/auto-publish";

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

  it("rejects weak identity, low margin, and non-positive profit", () => {
    expect(isAutoPublishCandidate({ ...qualified, matchConfidence: 94 })).toBe(false);
    expect(isAutoPublishCandidate({ ...qualified, marginPct: 14 })).toBe(false);
    expect(isAutoPublishCandidate({ ...qualified, profitCents: 0 })).toBe(false);
    expect(isAutoPublishCandidate({ ...qualified, matchVerdict: "REVIEW" })).toBe(false);
  });
});
