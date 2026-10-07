import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ find: vi.fn(), hold: vi.fn(), assess: vi.fn(), decisions: vi.fn(), publish: vi.fn(), policy: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findUnique: mocks.find, updateMany: mocks.hold } } }));
vi.mock("@/lib/ai/jev", () => ({ evaluateJevDecision: mocks.decisions }));
vi.mock("@/lib/arbitrage/product-match", () => ({ assessProductMatch: mocks.assess, assessProductMatchRules: () => ({ verdict: "MATCH" }) }));
vi.mock("@/lib/arbitrage/admin-catalog", () => ({ publishCatalogProductToUsers: mocks.publish }));
vi.mock("@/lib/arbitrage/automatic-review-policy", () => ({ automaticReviewDecision: mocks.policy }));
vi.mock("@/lib/arbitrage/pricing", () => ({ arbitrageSuggestedPriceCents: () => 5000 }));
vi.mock("@/lib/fees", () => ({ estimateMargin: () => ({ estimatedProfitCents: 1000, marginPct: 20 }) }));
import { reviewSavedCatalogCandidate } from "@/lib/arbitrage/review-saved-candidate";
const row = () => ({ id: "a", status: "NO_MATCH", matchConfidence: 98, matchMethod: "AI", matchVerdict: "MATCH", ebayTitle: "Acme AB123 lamp", ebayItemId: "123", amazonTitle: "Acme AB123 lamp", amazonBrand: "Acme", amazonDescription: "Lamp details", amazonBulletPointsJson: '["Feature"]', amazonImageUrl: "amazon photo", ebayImageUrl: "ebay photo", amazonImportDetailsJson: "{}", lastResearchedAt: new Date(), updatedAt: new Date(), amazonRefreshedAt: new Date(), competitorCount: 3, estimatedSales30d: 10, averageCompetitorPriceCents: 5000 });
beforeEach(() => { vi.resetAllMocks(); mocks.find.mockResolvedValue(row()); mocks.assess.mockResolvedValue({ method: "AI", verdict: "MATCH", confidence: 98 }); mocks.policy.mockReturnValue({ publish: true, reason: "Strict gates passed" }); mocks.decisions.mockResolvedValue({ sameProduct: { type: "boolean", probability: 0.995 }, conflict: { type: "boolean", probability: 0.001 } }); });
it("publishes with a concurrency guard only after both AI and Decisions checks pass", async () => {
  await reviewSavedCatalogCandidate("a"); expect(mocks.publish).toHaveBeenCalledWith("a", expect.objectContaining({ updatedAt: expect.any(Date), confidence: 98, reason: expect.stringContaining("99.5%") }));
});
it.each([null, { sameProduct: { type: "boolean", probability: 0.95 }, conflict: { type: "boolean", probability: 0 } }, { sameProduct: { type: "boolean", probability: 1 }, conflict: { type: "boolean", probability: 0.1 } }])("holds missing or uncertain Decisions answers", async (answers) => {
  mocks.decisions.mockResolvedValue(answers); await reviewSavedCatalogCandidate("a"); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.hold).toHaveBeenCalled();
});
it("does not override explicitly rejected candidates", async () => {
  mocks.find.mockResolvedValue({ ...row(), matchMethod: "MANUAL_REJECTED" }); await reviewSavedCatalogCandidate("a"); expect(mocks.assess).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
it("requires visual AI instead of a rule-only fallback", async () => {
  mocks.assess.mockResolvedValue({ method: "RULES", verdict: "MATCH", confidence: 100 }); await reviewSavedCatalogCandidate("a"); expect(mocks.decisions).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
it("never uses a positive decision to override profit/identity gates", async () => {
  mocks.policy.mockReturnValue({ publish: false, reason: "Unprofitable" }); await reviewSavedCatalogCandidate("a"); expect(mocks.decisions).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});
