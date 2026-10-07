import { AMAZON_FRESHNESS_WINDOW_MS, latestAmazonCheckAt } from "@/lib/amazon/freshness";

export const CATALOG_REPORT_TIME_ZONE = "America/Los_Angeles";
export function catalogDay(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CATALOG_REPORT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function catalogReportDays(now: Date, days = 30) {
  const today = new Date(`${catalogDay(now)}T12:00:00Z`);
  return Array.from({ length: days }, (_, index) => new Date(today.getTime() - (days - 1 - index) * 86400000).toISOString().slice(0, 10));
}
type CatalogRecord = { amazonRefreshedAt: Date | null; amazonCheckedAt: Date | null; amazonInStock: boolean };
export function summarizeCatalogFreshness(rows: CatalogRecord[], now = new Date()) {
  const buckets = [
    { label: "Fresh · under 24h", count: 0, color: "#10b981" },
    { label: "1–3 days old", count: 0, color: "#6366f1" },
    { label: "3–7 days old", count: 0, color: "#f59e0b" },
    { label: "Over 7 days old", count: 0, color: "#f43f5e" },
    { label: "No saved update", count: 0, color: "#94a3b8" },
  ];
  let lastUpdated: Date | null = null, lastChecked: Date | null = null, needsFirstCheck = 0, attemptedWithoutUpdate = 0, unavailable = 0;
  for (const row of rows) {
    const updated = row.amazonRefreshedAt;
    const age = updated ? Math.max(0, now.getTime() - updated.getTime()) : Infinity;
    const index = !updated ? 4 : age <= AMAZON_FRESHNESS_WINDOW_MS ? 0 : age <= 3 * 86400000 ? 1 : age <= 7 * 86400000 ? 2 : 3;
    buckets[index].count++;
    if (updated && (!lastUpdated || updated > lastUpdated)) lastUpdated = updated;
    const checked = latestAmazonCheckAt(row.amazonCheckedAt, updated);
    if (!checked) needsFirstCheck++;
    if (checked && (!lastChecked || checked > lastChecked)) lastChecked = checked;
    if (row.amazonCheckedAt && (!updated || row.amazonCheckedAt > updated)) attemptedWithoutUpdate++;
    if (!row.amazonInStock) unavailable++;
  }
  return { total: rows.length, fresh: buckets[0].count, needsUpdate: rows.length - buckets[0].count, needsFirstCheck, attemptedWithoutUpdate, unavailable, buckets, lastUpdated: lastUpdated?.toISOString() ?? null, lastChecked: lastChecked?.toISOString() ?? null };
}
