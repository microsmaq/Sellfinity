import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ state: vi.fn(), groups: vi.fn(), lists: vi.fn(), activity: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { keepaDiscoveryState: { findUnique: mocks.state }, keepaDiscoveryItem: { groupBy: mocks.groups, count: mocks.count }, keepaBestsellerList: { aggregate: mocks.lists }, $queryRaw: mocks.activity } }));
import { getKeepaImportSummary, keepaRunTelemetry } from "@/lib/keepa/reporting";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("KEEPA_API_KEY", "test-only");
  mocks.state.mockResolvedValue({ enabled: true, initializedAt: new Date(), lastSchedulerAt: new Date("2026-10-20T12:00:00Z"), nextRunAt: null, dailyTokenBudget: 28800, budgetDay: "2026-10-20", spentTokens: 81 });
  mocks.groups.mockResolvedValue([ { status: "IMPORTED", _count: 30 }, { status: "PENDING", _count: 70 }, { status: "SAVED", _count: 20 }, { status: "UNKNOWN", _count: 2 }, { status: "SKIPPED", _count: 3 } ]);
  mocks.lists.mockResolvedValue({ _sum: { existingCount: 10, duplicateCount: 5, totalAsins: 1000, cursor: 130 } });
  mocks.activity.mockResolvedValue([{ day: "2026-10-20", added: 10 }, { day: "2026-10-19", added: 20 }]); mocks.count.mockResolvedValue(10);
});
describe("Keepa dashboard progress", () => {
  it("separates real database additions from attempts, queued and skipped entries", async () => {
    const report = await getKeepaImportSummary(new Date("2026-10-20T12:01:00Z"));
    expect(report).toMatchObject({ imported: 30, queued: 90, review: 2, skipped: 18, addedToday: 10, preparedAsins: 125, discoveredAsins: 1000, checkedAsins: 130, spentToday: 81, schedulerHealthy: true });
    expect(report.series).toHaveLength(7); expect(report.series.reduce((sum, row) => sum + row.added, 0)).toBe(30);
    expect(String(mocks.activity.mock.calls[0][0])).toContain("'IMPORTED'");
  });
  it("reports stale scheduler heartbeats instead of claiming the worker is running", async () => {
    expect((await getKeepaImportSummary(new Date("2026-10-20T12:04:00Z"))).schedulerHealthy).toBe(false);
  });
  it("returns zero spending when the saved budget belongs to the previous UTC day", async () => {
    expect((await getKeepaImportSummary(new Date("2026-10-21T01:00:00Z"))).spentToday).toBe(0);
  });
  it("returns a safe first-deployment summary without initializing or spending tokens", async () => {
    mocks.state.mockResolvedValue(null); mocks.groups.mockResolvedValue([]); mocks.activity.mockResolvedValue([]);
    expect(await getKeepaImportSummary(new Date("2026-10-20T12:01:00Z"))).toMatchObject({ initialized: false, imported: 0, addedToday: 0, dailyBudget: 28800 });
  });
  it("logs only aggregate operational information, not secret keys", async () => {
    expect(await keepaRunTelemetry(new Date("2026-10-20T12:00:00Z"))).toEqual({ addedThisTick: 10, enabled: true, spentTokens: 81, nextRunAt: null });
  });
});
