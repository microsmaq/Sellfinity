import { describe, expect, it } from "vitest";
import { catalogDay, catalogReportDays, summarizeCatalogFreshness } from "../src/lib/admin/catalog-stats";
describe("admin catalog dashboard stats", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const row = (hours: number | null, checked = false) => ({ amazonRefreshedAt: hours === null ? null : new Date(now.getTime() - hours * 3600000), amazonCheckedAt: checked ? now : null, amazonInStock: true });
  it("separates freshness buckets, failed attempts and missing data", () => {
    const result = summarizeCatalogFreshness([row(12), row(48, true), row(100), row(200), row(null), { ...row(1), amazonInStock: false }], now);
    expect(result.buckets.map((bucket) => bucket.count)).toEqual([2, 1, 1, 1, 1]);
    expect(result).toMatchObject({ total: 6, fresh: 2, needsUpdate: 4, needsFirstCheck: 1, attemptedWithoutUpdate: 1, unavailable: 1, lastChecked: now.toISOString() });
  });
  it("does not refresh stale data after a recent failed browser attempt", () => {
    expect(summarizeCatalogFreshness([row(72, true)], now)).toMatchObject({ fresh: 0, needsUpdate: 1, attemptedWithoutUpdate: 1 });
  });
  it("handles an empty database", () => {
    expect(summarizeCatalogFreshness([], now)).toMatchObject({ total: 0, fresh: 0, lastUpdated: null, lastChecked: null });
  });
  it("uses Pacific calendar dates across UTC midnight and daylight saving", () => {
    expect(catalogDay(new Date("2026-10-06T02:00:00Z"))).toBe("2026-10-05");
    const days = catalogReportDays(new Date("2026-11-02T06:00:00Z"), 3);
    expect(days).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});
