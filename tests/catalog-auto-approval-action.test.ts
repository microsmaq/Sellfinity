import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), config: vi.fn(), run: vi.fn(), revalidate: vi.fn(), findMany: vi.fn(), where: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findMany: mocks.findMany } } }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/ai/jev", () => ({ jevConfiguration: mocks.config }));
vi.mock("@/lib/arbitrage/automatic-review", () => ({ catalogReviewSettings: vi.fn(), highConfidenceCatalogWhere: mocks.where, runAutomaticCatalogReview: mocks.run }));
import { prepareCatalogAutoApproval, reviewHighConfidenceCatalogNow } from "@/lib/actions/catalog-review";
beforeEach(() => {
  vi.resetAllMocks(); mocks.admin.mockResolvedValue({ id: "admin" }); mocks.config.mockReturnValue({ enabled: true, configured: true });
  mocks.run.mockResolvedValue({ processed: 1, published: 1, review: 0, failed: 0, queued: 0, items: [] });
  mocks.where.mockReturnValue({ status: "NO_MATCH", matchConfidence: { gte: 95 } }); mocks.findMany.mockResolvedValue([{ id: "one" }, { id: "two" }]);
});
it("snapshots up to 100 eligible products without a paid review or publication call", async () => {
  expect(await prepareCatalogAutoApproval(undefined, 100)).toEqual({ ids: ["one", "two"] });
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, select: { id: true } }));
  expect(mocks.run).not.toHaveBeenCalled();
});
it("snapshots all eligible products without a hidden 25/100-item cap and preserves selected scope", async () => {
  await prepareCatalogAutoApproval(["one", "two"], "ALL");
  expect(mocks.where).toHaveBeenCalledWith(expect.any(Date), ["one", "two"]);
  expect(mocks.findMany.mock.calls[0][0]).not.toHaveProperty("take");
});
it("rejects an empty selected snapshot instead of treating it as all products", async () => {
  await expect(prepareCatalogAutoApproval([], "ALL")).rejects.toThrow(); expect(mocks.findMany).not.toHaveBeenCalled();
});
it("requires administrator access and configured Decisions before preparing a large queue", async () => {
  mocks.admin.mockRejectedValueOnce(new Error("Forbidden")); await expect(prepareCatalogAutoApproval(undefined, "ALL")).rejects.toThrow("Forbidden");
  mocks.config.mockReturnValue({ configured: false, enabled: true });
  expect(await prepareCatalogAutoApproval(undefined, "ALL")).toMatchObject({ skipped: true }); expect(mocks.findMany).not.toHaveBeenCalled();
});
it("requires administrator access before checking configuration or running approval", async () => {
  mocks.admin.mockRejectedValue(new Error("Forbidden"));
  await expect(reviewHighConfidenceCatalogNow()).rejects.toThrow("Forbidden");
  expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});
it("passes the selected scope and chosen cap to the existing strict approval engine", async () => {
  expect(await reviewHighConfidenceCatalogNow(["one", "two"], 10)).toMatchObject({ published: 1 });
  expect(mocks.run).toHaveBeenCalledWith(true, true, { ids: ["one", "two"], limit: 10 });
  expect(mocks.revalidate).toHaveBeenCalledWith("/admin/arbitrage");
});
it("supports catalog-wide approval without changing daily automation preferences", async () => {
  await reviewHighConfidenceCatalogNow(undefined, 25);
  expect(mocks.run).toHaveBeenCalledWith(true, true, { ids: undefined, limit: 25 });
});
it.each([[[], 10], [["one"], 0], [["one"], 26]])("rejects empty selections and out-of-range limits without reviewing anything", async (ids, limit) => {
  await expect(reviewHighConfidenceCatalogNow(ids as string[], limit as number)).rejects.toThrow();
  expect(mocks.run).not.toHaveBeenCalled();
});
it("fails closed before paid image checks when Decisions is unavailable in configuration", async () => {
  mocks.config.mockReturnValue({ enabled: true, configured: false });
  expect(await reviewHighConfidenceCatalogNow()).toMatchObject({ skipped: true, reason: expect.stringContaining("no products were changed") });
  expect(mocks.run).not.toHaveBeenCalled();
});
