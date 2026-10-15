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
  it("approves a fully verified exact product match", () => {
    expect(automaticReviewDecision(facts).publish).toBe(true);
  });
  it("allows 95% visual matches only when the saved-review flow explicitly opts in", () => {
    const candidate = { ...facts, assessment: { ...facts.assessment, confidence: 95 } };
    expect(automaticReviewDecision(candidate).publish).toBe(false);
    expect(automaticReviewDecision(candidate, 95).publish).toBe(true);
    expect(automaticReviewDecision({ ...candidate, rulesRejected: true }, 95).publish).toBe(false);
  });
  it("does not trust an AI 100 score when variant evidence conflicts", () => {
    expect(automaticReviewDecision({ ...facts, ebayTitle: "Acme AB123 2 Pack Knee Strap Red 10 inch" }).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, ebayTitle: "Acme AB123 1 Pack Knee Strap Black 10 inch" }).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, ebayTitle: "Acme AB999 2 Pack Knee Strap Black 10 inch" }).publish).toBe(false);
  });
  it("holds incomplete identity details and lower-confidence matches", () => {
    expect(automaticReviewDecision({ ...facts, assessment: { ...facts.assessment, confidence: 99 } }).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, ebayImage: null }).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, brand: "" }).publish).toBe(false);
    expect(automaticReviewDecision({ ...facts, rulesRejected: true }).publish).toBe(false);
  });
  it("lets saved visual matches resolve title omissions with a separate Decisions check", () => {
    const candidate = { ...facts, ebayTitle: "AB123 Knee Strap", brand: "Acme", variant: "Black" };
    expect(automaticReviewDecision(candidate, 95).publish).toBe(false);
    expect(automaticReviewDecision(candidate, 95, true).publish).toBe(true);
    expect(automaticReviewDecision({ ...candidate, rulesRejected: true }, 95, true).publish).toBe(false);
    expect(automaticReviewDecision({ ...candidate, ebayImage: null }, 95, true).publish).toBe(false);
    expect(automaticReviewDecision({ ...candidate, assessment: { ...facts.assessment, method: "RULES" } }, 95, true).publish).toBe(false);
    expect(automaticReviewDecision({ ...candidate, assessment: { ...facts.assessment, confidence: 94 } }, 95, true).publish).toBe(false);
    expect(automaticReviewDecision({ ...candidate, assessment: { ...facts.assessment, verdict: "REVIEW" } }, 95, true).publish).toBe(false);
  });
  it("ignores availability, shipping, data age and missing price refreshes for identity approval", () => {
    const candidate = { ...facts, inStock: false, shippingVerified: false, amazonCheckedAt: null };
    expect(automaticReviewDecision(candidate).publish).toBe(true);
    expect(automaticReviewDecision({ ...candidate, rulesRejected: true }).publish).toBe(false);
  });
  it("does not gate admin identity approval on sales, profit or competitive pricing", () => {
    const candidate = { ...facts, hasMarketEvidence: false, averagePriceCents: null, profitCents: -500, marginPct: -20, suggestedPriceCents: 9000 };
    expect(automaticReviewDecision(candidate)).toMatchObject({ publish: true, reason: expect.stringContaining("product match verified") });
    expect(automaticReviewDecision({ ...candidate, ebayTitle: "Different brand AB999 1 Pack" }).publish).toBe(false);
  });
});
