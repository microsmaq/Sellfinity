import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), lease: vi.fn(), finish: vi.fn(), candidates: vi.fn(), research: vi.fn(), result: vi.fn(), count: vi.fn(), failed: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/arbitrage/admin-research", () => ({ researchAdminCatalogProduct: mocks.research }));
vi.mock("@/lib/arbitrage/review-saved-candidate", () => ({ reviewSavedCatalogCandidate: mocks.research }));
vi.mock("@/lib/db", () => ({ db: {
  adminCatalogReviewAutomation: { upsert: mocks.settings, updateMany: mocks.lease, update: mocks.finish },
  adminArbitrageProduct: { findMany: mocks.candidates, findUnique: mocks.result, count: mocks.count, updateMany: mocks.failed },
} }));
import { runAutomaticCatalogReview } from "@/lib/arbitrage/automatic-review";
describe("automatic pending-review queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings.mockResolvedValue({ enabled: true, dailyLimit: 5 });
    mocks.lease.mockResolvedValue({ count: 1 });
    mocks.candidates.mockResolvedValue([{ id: "one", asin: "B012345678" }]);
    mocks.result.mockResolvedValue({ status: "PUBLISHED", matchReason: "Passed strict gate" });
    mocks.count.mockResolvedValue(0);
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
});
