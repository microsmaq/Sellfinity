import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ find: vi.fn(), hold: vi.fn(), assess: vi.fn(), decisions: vi.fn(), publish: vi.fn(), policy: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findUnique: mocks.find, updateMany: mocks.hold } } }));
vi.mock("@/lib/ai/jev", () => ({ evaluateJevDecision: mocks.decisions }));
vi.mock("@/lib/arbitrage/product-match", () => ({ assessProductMatch: mocks.assess, assessProductMatchRules: () => ({ verdict: "MATCH" }) }));
vi.mock("@/lib/arbitrage/admin-catalog", () => ({ publishCatalogProductToUsers: mocks.publish }));
vi.mock("@/lib/arbitrage/automatic-review-policy", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/arbitrage/automatic-review-policy")>(), automaticReviewDecision: mocks.policy }));
vi.mock("@/lib/arbitrage/pricing", () => ({ arbitrageSuggestedPriceCents: () => 5000 }));
vi.mock("@/lib/fees", () => ({ estimateMargin: () => ({ estimatedProfitCents: 1000, marginPct: 20 }) }));
import { reviewSavedCatalogCandidate } from "@/lib/arbitrage/review-saved-candidate";
const row = () => ({ id: "a", status: "NO_MATCH", matchConfidence: 98, matchMethod: "AI", matchVerdict: "MATCH", ebayTitle: "Acme AB123 lamp", ebayItemId: "123", amazonTitle: "Acme AB123 lamp", amazonBrand: "Acme", amazonDescription: "Lamp details", amazonBulletPointsJson: '["Feature"]', amazonImageUrl: "amazon photo", ebayImageUrl: "ebay photo", amazonImportDetailsJson: "{}", lastResearchedAt: new Date(), updatedAt: new Date(), amazonRefreshedAt: new Date(), competitorCount: 3, estimatedSales30d: 10, averageCompetitorPriceCents: 5000 });
beforeEach(() => { vi.resetAllMocks(); mocks.find.mockResolvedValue(row()); mocks.assess.mockResolvedValue({ method: "AI", verdict: "MATCH", confidence: 98 }); mocks.policy.mockReturnValue({ publish: true, reason: "Strict gates passed" }); mocks.decisions.mockResolvedValue({ sameProduct: { type: "boolean", probability: 0.995 }, conflict: { type: "boolean", probability: 0.001 } }); });
it("publishes with a concurrency guard only after both AI and Decisions checks pass", async () => {
  await reviewSavedCatalogCandidate("a"); expect(mocks.publish).toHaveBeenCalledWith("a", expect.objectContaining({ updatedAt: expect.any(Date), confidence: 98, reason: expect.stringContaining("99.5%") }), { identityOnly: true });
});
it.each([null, {}, { sameProduct: { type: "boolean", probability: 0.949 }, conflict: { type: "boolean", probability: 0 } }, { sameProduct: { type: "boolean", probability: 1 }, conflict: { type: "boolean", probability: 0.1 } }])("holds missing or uncertain Decisions answers", async (answers) => {
  mocks.decisions.mockResolvedValue(answers); await reviewSavedCatalogCandidate("a"); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.hold).toHaveBeenCalled();
});
it("accepts the 95% match and 5% explicit-conflict boundary without inventing 100% confidence", async () => {
  mocks.decisions.mockResolvedValue({ sameProduct: { type: "boolean", probability: 0.95 }, conflict: { type: "boolean", probability: 0.05 } });
  await reviewSavedCatalogCandidate("a");
  expect(mocks.publish).toHaveBeenCalledWith("a", expect.objectContaining({ confidence: 95, reason: expect.stringContaining("95.0%") }), { identityOnly: true });
});
it("reports actual match and conflict scores when held, not the old 99% requirement", async () => {
  mocks.decisions.mockResolvedValue({ sameProduct: { type: "boolean", probability: 0.94 }, conflict: { type: "boolean", probability: 0.12 } });
  await reviewSavedCatalogCandidate("a");
  expect(mocks.hold.mock.calls[0][0].data.matchReason).toContain("94.0% (needs ≥95%)");
  expect(mocks.hold.mock.calls[0][0].data.matchReason).toContain("12.0% (must be ≤5%)");
});
it("distinguishes unavailable Decisions verification from a low identity score", async () => {
  mocks.decisions.mockResolvedValue(null); await reviewSavedCatalogCandidate("a");
  expect(mocks.hold.mock.calls[0][0].data.matchReason).toContain("unavailable or returned an unusable response");
});
it("supplies both images, separates missing details from contradictions and does not anchor Decisions to a prior score", async () => {
  const item = { ...row(), matchConfidence: 100, amazonImageUrl: "https://example.com/amazon.jpg", ebayImageUrl: "https://example.com/ebay.jpg", amazonImportDetailsJson: '{"variant":"Black"}' };
  mocks.find.mockResolvedValue(item); await reviewSavedCatalogCandidate("a");
  const [evidence, questions, , , images] = mocks.decisions.mock.calls[0];
  expect(images).toEqual([item.amazonImageUrl, item.ebayImageUrl]);
  expect(evidence.amazon.variant).toBe("Black"); expect(evidence).not.toHaveProperty("verification");
  expect(questions.conflict.instructions).toContain("omitted attribute or abbreviated title alone is not an explicit contradiction");
  expect(questions.sameProduct.instructions).toContain("Do not invent missing decisive facts");
  expect(mocks.policy).toHaveBeenCalledWith(expect.any(Object), 95, true);
});
it("allows shorter saved titles through the real policy only when both verifiers confirm identity", async () => {
  const { automaticReviewDecision } = await vi.importActual<typeof import("@/lib/arbitrage/automatic-review-policy")>("@/lib/arbitrage/automatic-review-policy");
  mocks.policy.mockImplementation(automaticReviewDecision);
  mocks.find.mockResolvedValue({ ...row(), amazonBrand: "Acme", amazonTitle: "Acme AB123 2 Pack Lamp Black 10 inch", ebayTitle: "AB123 Lamp", amazonImportDetailsJson: '{"variant":"Black"}' });
  mocks.decisions.mockResolvedValue({ sameProduct: { type: "boolean", probability: 0.97 }, conflict: { type: "boolean", probability: 0.02 } });
  await reviewSavedCatalogCandidate("a");
  expect(mocks.publish).toHaveBeenCalledWith("a", expect.objectContaining({ confidence: 97 }), { identityOnly: true });
});
it("reports actual identity conflicts instead of labeling them an unavailable visual service", async () => {
  mocks.assess.mockResolvedValue({ method: "RULES", verdict: "REJECTED", confidence: 98, reason: "Conflicting model identifiers (AB123 vs AB999)." });
  await reviewSavedCatalogCandidate("a");
  expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.decisions).not.toHaveBeenCalled();
  expect(mocks.hold.mock.calls[0][0].data.matchReason).toContain("Conflicting model identifiers");
});
it("does not override explicitly rejected candidates", async () => {
  mocks.find.mockResolvedValue({ ...row(), matchMethod: "MANUAL_REJECTED" }); await reviewSavedCatalogCandidate("a"); expect(mocks.assess).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
it("requires visual AI instead of a rule-only fallback", async () => {
  mocks.assess.mockResolvedValue({ method: "RULES", verdict: "MATCH", confidence: 100 }); await reviewSavedCatalogCandidate("a"); expect(mocks.decisions).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
it("never uses a positive decision to override identity gates", async () => {
  mocks.policy.mockReturnValue({ publish: false, reason: "Wrong variant" }); await reviewSavedCatalogCandidate("a"); expect(mocks.decisions).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
it.each([25, 48, 72])("does not impose an eBay market-data freshness gate at %s hours", async (hours) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    mocks.find.mockResolvedValue({ ...row(), lastResearchedAt: new Date(now - hours * 60 * 60 * 1000) });
    await reviewSavedCatalogCandidate("a"); expect(mocks.publish).toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});
it.each([null, 30 * 24 * 60 * 60 * 1000])("approves exact matches despite missing or old market evidence and unusable cost data", async (age) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    mocks.find.mockResolvedValue({ ...row(), lastResearchedAt: age === null ? null : new Date(now - age), amazonRefreshedAt: null, amazonInStock: false, amazonShippingVerified: false, amazonPriceCents: 0, averageCompetitorPriceCents: null, competitorCount: null, estimatedSales30d: null, amazonDescription: "", amazonBulletPointsJson: "[]" });
    await reviewSavedCatalogCandidate("a");
    expect(mocks.assess).toHaveBeenCalled(); expect(mocks.decisions).toHaveBeenCalled(); expect(mocks.publish).toHaveBeenCalledWith("a", expect.any(Object), { identityOnly: true });
  } finally { clock.mockRestore(); }
});
