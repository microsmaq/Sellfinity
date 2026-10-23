import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), rows: vi.fn(), ban: vi.fn(), remove: vi.fn(), stock: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import { adminBanItems } from "@/lib/actions/admin-arbitrage";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.rows.mockResolvedValue([{ id: "one", asin: "B012345678" }]);
  mocks.transaction.mockImplementation((fn) => fn({ adminArbitrageProduct: { findMany: mocks.rows, updateMany: mocks.ban }, arbitrageItem: { deleteMany: mocks.remove }, product: { updateMany: mocks.stock } }));
});

describe("admin ban and remove", () => {
  it("retains a durable ban, removes discovery records and marks the source unavailable across all users", async () => {
    expect(await adminBanItems(["one", "one"])).toMatchObject({ ok: true, message: expect.stringContaining("1 product banned") });
    expect(mocks.rows.mock.calls[0][0].where).toEqual({ id: { in: ["one"] } });
    expect(mocks.ban.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["one"] } }, data: { bannedAt: expect.any(Date), status: "ARCHIVED", amazonInStock: false } });
    expect(mocks.remove).toHaveBeenCalledWith({ where: { asin: { in: ["B012345678"] } } });
    expect(mocks.stock.mock.calls[0][0]).toEqual({ where: { supplierName: "Amazon", OR: [{ supplierProductId: { in: ["B012345678"] } }, { sku: { in: ["B012345678"] } }] }, data: { supplierStock: 0 } });
  });
  it("does not affect other products or report success for missing catalog rows", async () => {
    mocks.rows.mockResolvedValue([]);
    expect(await adminBanItems(["gone"])).toMatchObject({ ok: false });
    expect(mocks.ban).not.toHaveBeenCalled(); expect(mocks.stock).not.toHaveBeenCalled();
  });
  it("requires admin authorization before starting a transaction", async () => {
    mocks.admin.mockRejectedValue(new Error("Forbidden"));
    await expect(adminBanItems(["one"])).rejects.toThrow("Forbidden");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("rejects an empty selection", async () => {
    expect(await adminBanItems([])).toMatchObject({ ok: false });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
