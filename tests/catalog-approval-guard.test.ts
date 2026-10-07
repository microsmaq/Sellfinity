import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), guard: vi.fn(), upsert: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findUnique: mocks.find }, $transaction: async (work: (tx: unknown) => unknown) => work({ adminArbitrageProduct: { updateMany: mocks.guard, update: mocks.update }, arbitrageItem: { upsert: mocks.upsert } }) } }));
import { publishCatalogProductToUsers } from "@/lib/arbitrage/admin-catalog";
const updatedAt = new Date();
beforeEach(() => {
  vi.resetAllMocks(); mocks.guard.mockResolvedValue({ count: 1 });
  mocks.find.mockResolvedValue({ id: "a", asin: "B012345678", amazonInStock: true, amazonShippingVerified: true, amazonImportDetailsJson: "{}", ebayItemId: "123", ebayTitle: "Lamp", ebayPriceCents: 5000, ebayUrl: "https://www.ebay.com/itm/123", amazonPriceCents: 1000, amazonShippingCents: 0 });
});
it("does not publish a candidate changed or rejected during AI review", async () => {
  mocks.guard.mockResolvedValue({ count: 0 });
  await expect(publishCatalogProductToUsers("a", { updatedAt, confidence: 95, reason: "Verified" })).rejects.toThrow("changed during automatic approval");
  expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
});
it("records the actual approval confidence and Decisions method without claiming manual verification", async () => {
  await publishCatalogProductToUsers("a", { updatedAt, confidence: 95, reason: "Verified" });
  expect(mocks.guard.mock.calls[0][0].where).toEqual({ id: "a", status: "NO_MATCH", updatedAt });
  expect(mocks.upsert.mock.calls[0][0].create).toMatchObject({ matchVerdict: "MATCH", matchConfidence: 95, matchMethod: "DECISIONS" });
  expect(mocks.update.mock.calls[0][0].data).toMatchObject({ status: "PUBLISHED", matchConfidence: 95, matchMethod: "DECISIONS" });
});
