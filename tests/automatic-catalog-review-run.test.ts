import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), lease: vi.fn(), finish: vi.fn(), candidates: vi.fn(), research: vi.fn(), result: vi.fn(), count: vi.fn(), failed: vi.fn(), prioritize: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/arbitrage/admin-research", () => ({ researchAdminCatalogProduct: mocks.research }));
vi.mock("@/lib/arbitrage/review-saved-candidate", () => ({ reviewSavedCatalogCandidate: mocks.research }));
vi.mock("@/lib/ai/jev-workflows", () => ({ prioritizeCatalogReview: mocks.prioritize }));
vi.mock("@/lib/db", () => ({ db: {
  adminCatalogReviewAutomation: { upsert: mocks.settings, updateMany: mocks.lease, update: mocks.finish },
  adminArbitrageProduct: { findMany: mocks.candidates, findUnique: mocks.result, count: mocks.count, updateMany: mocks.failed },
} }));
import { highConfidenceCatalogWhere, runAutomaticCatalogReview } from "@/lib/arbitrage/automatic-review";
describe("automatic pending-review queue", () => {
  it("uses a 3-day Amazon cutoff for manual approval queue preparation", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    expect(highConfidenceCatalogWhere(now).amazonRefreshedAt.gte).toEqual(new Date("2026-10-12T12:00:00Z"));
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings.mockResolvedValue({ enabled: true, dailyLimit: 5 });
    mocks.lease.mockResolvedValue({ count: 1 });
    mocks.candidates.mockResolvedValue([{ id: "one", asin: "B012345678" }]);
    mocks.result.mockResolvedValue({ status: "PUBLISHED", matchReason: "Passed strict gate" });
    mocks.count.mockResolvedValue(0);
    mocks.prioritize.mockImplementation(async (items) => items);
  });
  it("does no research when disabled or another review holds the lease", async () => {
    mocks.settings.mockResolvedValueOnce({ enabled: false });
    expect(await runAutomaticCatalogReview()).toMatchObject({ skipped: true });
    mocks.lease.mockResolvedValueOnce({ count: 0 });
    expect(await runAutomaticCatalogReview()).toMatchObject({ skipped: true });
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it("uses the strict saved-data review path and records the outcome", async () => {
    expect(await runAutomaticCatalogReview()).toMatchObject({ processed: 1, published: 1 });
    expect(mocks.research).toHaveBeenCalledWith("one", { automatic: true, ebayOnly: true });
    expect(mocks.finish).toHaveBeenLastCalledWith({ where: { id: "main" }, data: { lockUntil: null } });
  });
  it("preserves failed candidates for manual review rather than publishing them", async () => {
    mocks.research.mockRejectedValue(new Error("eBay unavailable"));
    expect(await runAutomaticCatalogReview()).toMatchObject({ processed: 1, published: 0, failed: 1 });
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "one", status: "PENDING" }, data: expect.objectContaining({ status: "NO_MATCH" }) }));
  });
  it("scopes selected approval to fresh high-confidence review pairs and skips extra queue-ranking AI", async () => {
    mocks.candidates.mockResolvedValue([{ id: "one", asin: "B012345678", status: "NO_MATCH" }]);
    expect(await runAutomaticCatalogReview(true, true, { ids: ["one", "two"], limit: 10 })).toMatchObject({ processed: 1, published: 1 });
    expect(mocks.candidates).toHaveBeenCalledWith(expect.objectContaining({ take: 10, orderBy: { updatedAt: "asc" }, where: expect.objectContaining({ id: { in: ["one", "two"] }, status: "NO_MATCH", matchConfidence: { gte: 95 }, matchVerdict: { not: "REJECTED" }, amazonShippingVerified: true, amazonRefreshedAt: { gte: expect.any(Date) } }) }));
    expect(mocks.research).toHaveBeenCalledWith("one");
    expect(mocks.prioritize).not.toHaveBeenCalled();
  });
  it("retains the daily cap for scheduled review and clamps manual batch size", async () => {
    await runAutomaticCatalogReview(false, true, { limit: 100 });
    expect(mocks.candidates).toHaveBeenLastCalledWith(expect.objectContaining({ take: 5 }));
    await runAutomaticCatalogReview(true, true, { limit: 100 });
    expect(mocks.candidates).toHaveBeenLastCalledWith(expect.objectContaining({ take: 25 }));
  });
});
