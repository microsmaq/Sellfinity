import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { findMany: mocks.findMany, findUnique: mocks.findUnique, updateMany: mocks.updateMany } } }));
import { prepareCatalogContentRepair, recordCatalogContentCheck } from "@/lib/actions/catalog-import";
beforeEach(() => { vi.resetAllMocks(); });
it("prioritizes never checked incomplete records, then oldest attempts, excluding complete ones", async () => {
  const row = (id: string, checked: string | null, complete = false) => ({ id, asin: "B012345678", amazonTitle: "Lamp", amazonDescription: complete ? "Ceramic lamp details" : "", amazonImageUrl: "photo", amazonBulletPointsJson: '["Feature"]', amazonImportDetailsJson: JSON.stringify({ contentCheckedAt: checked }), createdAt: new Date("2026-01-01") });
  mocks.findMany.mockResolvedValue([row("recent", "2026-10-07"), row("old", "2026-10-01"), row("never", null), row("complete", null, true)]);
  expect((await prepareCatalogContentRepair(2)).candidates.map((entry) => entry.id)).toEqual(["never", "old"]);
});
it("records an attempt without changing prices, stock, matches or price freshness", async () => {
  mocks.findUnique.mockResolvedValue({ id: "a", updatedAt: new Date(), amazonImportDetailsJson: '{"source":"BROWSER","variant":"blue"}' });
  await recordCatalogContentCheck("a");
  const data = mocks.updateMany.mock.calls[0][0].data;
  expect(Object.keys(data)).toEqual(["amazonImportDetailsJson"]);
  expect(JSON.parse(data.amazonImportDetailsJson)).toMatchObject({ source: "BROWSER", variant: "blue", contentCheckedAt: expect.any(String) });
});
it("requires admin access", async () => {
  mocks.auth.mockRejectedValue(new Error("Forbidden")); await expect(prepareCatalogContentRepair(10)).rejects.toThrow("Forbidden"); expect(mocks.findMany).not.toHaveBeenCalled();
});
