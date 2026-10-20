import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), status: vi.fn(), advance: vi.fn(), upsert: vi.fn(), stateFind: vi.fn(), stateUpdate: vi.fn(), listFind: vi.fn(), listCreate: vi.fn(), listUpdate: vi.fn(), listUpdateMany: vi.fn(), itemUpdateMany: vi.fn(), itemFind: vi.fn(), transaction: vi.fn(), queryRaw: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/keepa/discovery", () => ({ advanceKeepaDiscovery: mocks.advance, keepaDiscoveryStatus: mocks.status }));
vi.mock("@/lib/keepa/reporting", () => ({ getKeepaImportSummary: mocks.status }));
const tx = { keepaDiscoveryState: { findUniqueOrThrow: mocks.stateFind, update: mocks.stateUpdate }, keepaBestsellerList: { findUnique: mocks.listFind, create: mocks.listCreate, update: mocks.listUpdate, updateMany: mocks.listUpdateMany }, keepaDiscoveryItem: { updateMany: mocks.itemUpdateMany }, $queryRaw: mocks.queryRaw };
vi.mock("@/lib/db", () => ({ db: { keepaDiscoveryState: { upsert: mocks.upsert, update: mocks.stateUpdate }, keepaDiscoveryItem: { findUnique: mocks.itemFind }, $transaction: mocks.transaction } }));
import { configureKeepaDiscovery, getKeepaDashboardSummary, getKeepaDiscoveryStatus, getSavedKeepaProduct, queueKeepaBestsellers, queueKeepaCategories, retryUncertainKeepaRequests, runKeepaDiscoveryStep } from "@/lib/actions/keepa-discovery";

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("KEEPA_API_KEY", "test-only");
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.upsert.mockResolvedValue({ lockUntil: null, categoryStatus: "DONE" });
  mocks.stateFind.mockResolvedValue({ lockUntil: null, categoryStatus: "DONE" });
  mocks.listFind.mockResolvedValue(null); mocks.status.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
});
describe("admin-only Keepa actions", () => {
  it.each([
    () => getKeepaDiscoveryStatus(), () => getKeepaDashboardSummary(), () => runKeepaDiscoveryStep(),
    () => configureKeepaDiscovery({ enabled: true, dailyTokenBudget: 1000 }),
    () => queueKeepaCategories(), () => queueKeepaBestsellers([{ id: "123", name: "Home" }]),
    () => retryUncertainKeepaRequests(true), () => getSavedKeepaProduct("B000000001"),
  ])("requires administrator access before any work", async (action) => {
    mocks.admin.mockRejectedValue(new Error("Forbidden")); await expect(action()).rejects.toThrow("Forbidden");
    expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("reuses root categories without paying to reload", async () => {
    await queueKeepaCategories(); expect(mocks.stateUpdate).not.toHaveBeenCalled();
  });
  it("reuses existing bestseller snapshots by default", async () => {
    mocks.listFind.mockResolvedValue({ status: "DONE" });
    await queueKeepaBestsellers([{ id: "123", name: "Home" }, { id: "123", name: "Home" }]);
    expect(mocks.listFind).toHaveBeenCalledTimes(1); expect(mocks.listUpdate).not.toHaveBeenCalled(); expect(mocks.listCreate).not.toHaveBeenCalled();
  });
  it("does not throw away an unfinished saved list for a fresh paid request", async () => {
    mocks.listFind.mockResolvedValue({ status: "SAVED" });
    await expect(queueKeepaBestsellers([{ id: "123", name: "Home" }], true)).rejects.toThrow("Finish or resume"); expect(mocks.listUpdate).not.toHaveBeenCalled();
  });
  it("refetches a completed list only on explicit request", async () => {
    mocks.listFind.mockResolvedValue({ status: "DONE" });
    await queueKeepaBestsellers([{ id: "123", name: "Home" }], true);
    expect(mocks.listUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "QUEUED", responseJson: null, cursor: 0 }) }));
  });
  it("blocks queue changes when a worker acquires the lease during configuration", async () => {
    mocks.stateFind.mockResolvedValue({ lockUntil: new Date(Date.now() + 60000) });
    await expect(queueKeepaBestsellers([{ id: "123", name: "Home" }])).rejects.toThrow("finishing"); expect(mocks.listCreate).not.toHaveBeenCalled();
  });
  it("requires confirmation to retry uncertain paid requests", async () => {
    await expect(retryUncertainKeepaRequests(false)).rejects.toThrow("Confirm"); expect(mocks.itemUpdateMany).not.toHaveBeenCalled();
    await retryUncertainKeepaRequests(true);
    expect(mocks.itemUpdateMany).toHaveBeenCalledWith({ where: { status: { in: ["UNKNOWN", "FETCHING"] } }, data: { status: "PENDING", error: null } });
    // Successful, missing, or review snapshots are not resubmitted.
  });
  it("validates the budget and category IDs before writes", async () => {
    await expect(configureKeepaDiscovery({ enabled: true, dailyTokenBudget: 49 })).rejects.toThrow();
    await expect(queueKeepaBestsellers([{ id: "bad", name: "Home" }])).rejects.toThrow();
    expect(mocks.stateUpdate).not.toHaveBeenCalled(); expect(mocks.listCreate).not.toHaveBeenCalled();
  });
  it("returns saved snapshots without spending provider tokens", async () => {
    mocks.itemFind.mockResolvedValue({ responseJson: '{"asin":"B000000001"}' });
    expect(await getSavedKeepaProduct("b000000001")).toBe('{"asin":"B000000001"}'); expect(mocks.advance).not.toHaveBeenCalled();
  });
});
