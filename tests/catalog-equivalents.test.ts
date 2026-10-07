import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), research: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findMany: mocks.findMany, findUnique: mocks.findUnique } } }));
vi.mock("@/lib/arbitrage/admin-research", () => ({ researchAdminCatalogProduct: mocks.research }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { prepareCatalogEquivalentResearch, researchCatalogEquivalent } from "@/lib/actions/catalog-equivalents";
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ id: "admin" }); });
it("prepares all eligible pending records, not just the visible page", async () => {
  mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
  expect(await prepareCatalogEquivalentResearch()).toEqual({ ids: ["a", "b"] });
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "PENDING", amazonShippingVerified: true }), orderBy: expect.any(Array) }));
  expect(mocks.research).not.toHaveBeenCalled();
});
it("limits selected research to pending/review rows and deduplicates IDs", async () => {
  mocks.findMany.mockResolvedValue([]); await prepareCatalogEquivalentResearch(["a", "a"]);
  expect(mocks.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ["a"] }, status: { in: ["PENDING", "NO_MATCH"] } });
});
it("uses stored Amazon data, eBay only and saves for review without publishing", async () => {
  mocks.findUnique.mockResolvedValueOnce({ status: "PENDING", amazonTitle: "Lamp" }).mockResolvedValueOnce({ ebayItemId: "123", matchReason: "Same model" });
  expect(await researchCatalogEquivalent("a")).toMatchObject({ ok: true, outcome: "matched" });
  expect(mocks.research).toHaveBeenCalledWith("a", { storedSource: true, ebayOnly: true, reviewOnly: true });
});
it("does not research already published records", async () => {
  mocks.findUnique.mockResolvedValue({ status: "PUBLISHED", amazonTitle: "Lamp" });
  expect(await researchCatalogEquivalent("a")).toMatchObject({ outcome: "skipped" }); expect(mocks.research).not.toHaveBeenCalled();
});
it("pauses on eBay throttling instead of continuing repeated calls", async () => {
  mocks.findUnique.mockResolvedValue({ status: "PENDING", amazonTitle: "Lamp" }); mocks.research.mockRejectedValue(new Error("eBay market search failed (429)"));
  expect(await researchCatalogEquivalent("a")).toMatchObject({ ok: false, pause: true });
});
it("requires administrator access", async () => {
  mocks.auth.mockRejectedValue(new Error("Forbidden")); await expect(prepareCatalogEquivalentResearch()).rejects.toThrow("Forbidden"); expect(mocks.findMany).not.toHaveBeenCalled();
});
