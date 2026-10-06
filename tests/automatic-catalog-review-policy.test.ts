import { describe, expect, it } from "vitest";
import { automaticReviewDecision } from "@/lib/arbitrage/automatic-review-policy";
const now = new Date("2026-10-06T12:00:00Z");
const facts = {
  assessment: { verdict: "MATCH" as const, confidence: 100, method: "AI" as const, reason: "Exact same product" },
  rulesRejected: false,
  amazonTitle: "Acme AB123 2 Pack Knee Strap Black 10 inch", ebayTitle: "Acme AB123 2 Pack Knee Strap Black 10 inch",
  brand: "Acme", variant: "Black", amazonImage: "https://example.com/amazon.jpg", ebayImage: "https://example.com/ebay.jpg",
  inStock: true, shippingVerified: true, amazonCheckedAt: now,
  suggestedPriceCents: 4900, ebayPriceCents: 5000, averagePriceCents: 5200, profitCents: 1000, marginPct: 20, hasMarketEvidence: true,
};
describe("strict automatic catalog publication", () => {
  it("publishes a fully verified exact match with profitable competitive pricing", () => {
    expect(automaticReviewDecision(facts, now).publish).toBe(true);
  });
  it("does not trust an AI 100 score when variant evidence conflicts", () => {
    expect(automaticReviewDecision({ ...facts, ebayTitle: "Acme AB123 2 Pack Knee Strap Red 10 inch" }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, ebayTitle: "Acme AB123 1 Pack Knee Strap Black 10 inch" }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, ebayTitle: "Acme AB999 2 Pack Knee Strap Black 10 inch" }, now).publish).toBe(false);
  });
  it("holds incomplete identity details and lower-confidence matches", () => {
    expect(automaticReviewDecision({ ...facts, assessment: { ...facts.assessment, confidence: 99 } }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, ebayImage: null }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, brand: "" }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, rulesRejected: true }, now).publish).toBe(false);
  });
  it("holds unavailable, unknown-shipping and stale Amazon records", () => {
    expect(automaticReviewDecision({ ...facts, inStock: false }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, shippingVerified: false }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, amazonCheckedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) }, now).publish).toBe(false);
  });
  it("requires real market evidence and profitable competitive pricing", () => {
    expect(automaticReviewDecision({ ...facts, hasMarketEvidence: false }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, profitCents: 0 }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, profitCents: 100, marginPct: 5 }, now).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, suggestedPriceCents: 9000 }, now).publish).toBe(false);
  });
});
