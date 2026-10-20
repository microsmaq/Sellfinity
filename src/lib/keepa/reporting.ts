import "server-only";
import { db } from "@/lib/db";
import { catalogDay, catalogReportDays } from "@/lib/admin/catalog-stats";

export async function getKeepaImportSummary(now = new Date()) {
  const days = catalogReportDays(now, 7);
  const [state, groups, lists, activity] = await Promise.all([
    db.keepaDiscoveryState.findUnique({ where: { id: "main" } }),
    db.keepaDiscoveryItem.groupBy({ by: ["status"], _count: true }),
    db.keepaBestsellerList.aggregate({ _sum: { existingCount: true, duplicateCount: true, totalAsins: true, cursor: true } }),
    db.$queryRaw<{ day: string; added: number }[]>`
      SELECT to_char(("updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS added
      FROM "KeepaDiscoveryItem"
      WHERE "status" = 'IMPORTED' AND "updatedAt" >= ${new Date(`${days[0]}T00:00:00Z`)}
      GROUP BY 1 ORDER BY 1
    `,
  ]);
  const count = new Map(groups.map((row) => [row.status, row._count]));
  const get = (status: string) => count.get(status) ?? 0;
  const series = days.map((day) => ({ day, added: activity.find((row) => row.day === day)?.added ?? 0 }));
  return {
    configured: Boolean(process.env.KEEPA_API_KEY?.trim()), enabled: state?.enabled ?? false,
    initialized: Boolean(state?.initializedAt), message: state?.message ?? "Automatic import will start at the first server check after deployment.",
    lastSchedulerAt: state?.lastSchedulerAt?.toISOString() ?? null,
    schedulerHealthy: Boolean(state?.lastSchedulerAt && now.getTime() - state.lastSchedulerAt.getTime() < 180000),
    nextRunAt: state?.nextRunAt?.toISOString() ?? null,
    addedToday: series.find((row) => row.day === catalogDay(now))?.added ?? 0,
    imported: get("IMPORTED"), queued: get("PENDING") + get("FETCHING") + get("SAVED"),
    review: get("REVIEW") + get("MISSING") + get("UNKNOWN"),
    skipped: (lists._sum.existingCount ?? 0) + (lists._sum.duplicateCount ?? 0) + get("SKIPPED"),
    discoveredAsins: lists._sum.totalAsins ?? 0, checkedAsins: lists._sum.cursor ?? 0,
    preparedAsins: groups.reduce((sum, row) => sum + row._count, 0),
    spentToday: state?.budgetDay === now.toISOString().slice(0, 10) ? state.spentTokens : 0,
    dailyBudget: state?.dailyTokenBudget ?? 28800, series,
  };
}

/** Operational counts only; no keys, product content or customer information. */
export async function keepaRunTelemetry(since: Date) {
  const [added, state] = await Promise.all([
    db.keepaDiscoveryItem.count({ where: { status: "IMPORTED", updatedAt: { gte: since } } }),
    db.keepaDiscoveryState.findUnique({ where: { id: "main" }, select: { enabled: true, spentTokens: true, nextRunAt: true } }),
  ]);
  return { addedThisTick: added, enabled: state?.enabled ?? false, spentTokens: state?.spentTokens ?? 0, nextRunAt: state?.nextRunAt?.toISOString() ?? null };
}
