import "server-only";
import { db } from "@/lib/db";
import { catalogReportDays, summarizeCatalogFreshness } from "./catalog-stats";

export async function getAdminCatalogHealth(now = new Date()) {
  const days = catalogReportDays(now);
  const [rows, activity, tracking] = await Promise.all([
    db.adminArbitrageProduct.findMany({ where: { status: { not: "ARCHIVED" } }, select: { amazonRefreshedAt: true, amazonCheckedAt: true, amazonInStock: true } }),
    db.adminCatalogDailyActivity.groupBy({ by: ["day"], where: { day: { gte: new Date(`${days[0]}T00:00:00Z`), lte: new Date(`${days.at(-1)}T00:00:00Z`) } }, _sum: { added: true, refreshed: true, checked: true } }),
    db.adminCatalogActivityTracking.findUnique({ where: { id: "main" } }),
  ]);
  const byDay = new Map(activity.map((row) => [row.day.toISOString().slice(0, 10), row._sum]));
  const series = days.map((date) => ({ date, added: byDay.get(date)?.added ?? 0, refreshed: byDay.get(date)?.refreshed ?? 0, checked: byDay.get(date)?.checked ?? 0 }));
  return { ...summarizeCatalogFreshness(rows, now), series, today: series.at(-1)!, trackingStartedAt: tracking?.startedAt.toISOString() ?? null };
}
