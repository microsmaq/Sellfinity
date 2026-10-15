import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ count: vi.fn(), rows: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { adminArbitrageProduct: { count: mocks.count, findMany: mocks.rows } } }));
import { listAdminCatalog } from "@/lib/arbitrage/admin-catalog";
beforeEach(() => { vi.resetAllMocks(); mocks.count.mockResolvedValue(0); mocks.rows.mockResolvedValue([]); });
it("the admin high-confidence filter applies identity, not hidden commercial criteria", async () => {
  await listAdminCatalog({ page: 1, filters: { query: "", status: "ALL", category: "ALL", matchVerdict: "ALL", source: "ALL", ebayMatch: "ALL", minMargin: 0, minConfidence: 0, qualifiedOnly: true, sortKey: "researched", sortDesc: true, pageSize: 50 } });
  const query = mocks.rows.mock.calls.find(([args]) => args.where)?.[0];
  expect(query.where.AND).toEqual([{ ebayItemId: { not: null }, matchVerdict: { in: ["MATCH", "LIKELY"] }, matchConfidence: { gte: 95 } }]);
  expect(query.take).toBe(50); expect(query.skip).toBe(0);
});
