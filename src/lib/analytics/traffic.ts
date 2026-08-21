import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError, type EbayClient, type ListingTrafficDayMetric, type ListingTrafficMetric } from "@/lib/ebay/client";

const BATCH_SIZE = 200;
const TOTAL_CACHE_MS = 6 * 60 * 60 * 1000;
const DAILY_CACHE_MS = 12 * 60 * 60 * 1000;

export type TrafficSnapshot = {
  rows: ListingTrafficMetric[];
  daily: ListingTrafficDayMetric[];
  error: string | null;
};

function trafficErrorMessage(error: unknown): string {
  if (error instanceof EbayApiError && error.status === 401) {
    return "Your eBay session expired. Reconnect eBay in Settings.";
  }
  if (error instanceof EbayApiError && error.status === 403) {
    return "eBay connected successfully, but its Analytics API denied this traffic report. Sellfinity will keep your sales data available while traffic access is retried.";
  }
  return "eBay traffic data is temporarily unavailable. Your connection is still active.";
}

async function loadTrafficBatch(
  client: EbayClient,
  userId: string,
  ids: string[],
  start: Date,
  end: Date,
): Promise<{ rows: ListingTrafficMetric[]; errors: unknown[] }> {
  try {
    return { rows: await client.getListingTraffic!(userId, ids, start, end), errors: [] };
  } catch (error) {
    // Never fan a provider failure out into one call per listing. eBay gives
    // traffic_report only 100 calls/day; saved rows are safer than exhausting
    // the quota while trying to isolate a bad ID.
    return { rows: [], errors: [error] };
  }
}

export function normalizeTrafficRate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value * 100;
  if (value > 100) return value / 100;
  return value;
}

export async function loadListingTraffic(input: {
  userId: string;
  ebayListingIds: string[];
  start: Date;
  end: Date;
  connected: boolean;
  trendScope?: "ACCOUNT" | "LISTINGS";
}): Promise<TrafficSnapshot> {
  const ids = [...new Set(input.ebayListingIds.filter(Boolean))];
  if (ids.length === 0) return { rows: [], daily: [], error: "No published eBay listings are available for traffic reporting." };
  if (!input.connected) return { rows: [], daily: [], error: "Connect eBay to load traffic data." };
  const day = (value: Date) => new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const periodStart = day(input.start);
  const periodEnd = day(input.end);
  const totalCutoff = new Date(Date.now() - TOTAL_CACHE_MS);
  const cachedTotals = await db.ebayListingTrafficSnapshot.findMany({
    where: { userId: input.userId, ebayListingId: { in: ids } },
  });
  const cachedById = new Map(cachedTotals.map((row) => [row.ebayListingId, row]));
  const staleIds = ids.filter((id) => {
    const row = cachedById.get(id);
    return !row || row.periodStart.getTime() !== periodStart.getTime()
      || row.periodEnd.getTime() !== periodEnd.getTime() || row.fetchedAt < totalCutoff;
  });

  try {
    const client = await getEbayClientForUser(input.userId);
    if (!client.getListingTraffic) throw new Error("Traffic reporting is unavailable.");
    const batches = Array.from({ length: Math.ceil(staleIds.length / BATCH_SIZE) }, (_, index) =>
      staleIds.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
    );
    const rowGroups = await Promise.all(batches.map((batch) =>
      loadTrafficBatch(client, input.userId, batch, input.start, input.end),
    ));
    let freshRows = rowGroups.flatMap((group) => group.rows).map((row) => ({
      ...row,
      clickThroughRate: normalizeTrafficRate(row.clickThroughRate),
      salesConversionRate: normalizeTrafficRate(row.salesConversionRate),
    }));
    const totalErrors = rowGroups.flatMap((group) => group.errors);
    if (totalErrors.length === 0) {
      const returnedIds = new Set(freshRows.map((row) => row.ebayListingId));
      freshRows = [
        ...freshRows,
        ...staleIds.filter((id) => !returnedIds.has(id)).map((ebayListingId) => ({
          ebayListingId,
          impressions: 0,
          views: 0,
          clickThroughRate: null,
          salesConversionRate: null,
        })),
      ];
    }
    for (let offset = 0; offset < freshRows.length; offset += 100) {
      await db.$transaction(freshRows.slice(offset, offset + 100).map((row) =>
        db.ebayListingTrafficSnapshot.upsert({
          where: { userId_ebayListingId: { userId: input.userId, ebayListingId: row.ebayListingId } },
          create: { userId: input.userId, periodStart, periodEnd, fetchedAt: new Date(), ...row },
          update: { periodStart, periodEnd, fetchedAt: new Date(), impressions: row.impressions, views: row.views, clickThroughRate: row.clickThroughRate, salesConversionRate: row.salesConversionRate },
        }),
      ));
    }
    const freshById = new Map(freshRows.map((row) => [row.ebayListingId, row]));
    const rows: ListingTrafficMetric[] = ids.flatMap((id) => {
      const fresh = freshById.get(id);
      if (fresh) return [fresh];
      const cached = cachedById.get(id);
      return cached ? [{ ebayListingId: id, impressions: cached.impressions, views: cached.views, clickThroughRate: cached.clickThroughRate, salesConversionRate: cached.salesConversionRate }] : [];
    });

    const yesterday = day(new Date(Date.now() - 86_400_000));
    const trendEnd = periodEnd < yesterday ? periodEnd : yesterday;
    const scopeKey = input.trendScope === "ACCOUNT"
      ? "ACCOUNT"
      : `LISTINGS:${createHash("sha256").update([...ids].sort().join("|")).digest("hex").slice(0, 24)}`;
    const cachedDaily = trendEnd >= periodStart ? await db.ebayTrafficDailySnapshot.findMany({
      where: { userId: input.userId, scopeKey, date: { gte: periodStart, lte: trendEnd } },
      orderBy: { date: "asc" },
    }) : [];
    const expectedDays = trendEnd >= periodStart
      ? Math.floor((trendEnd.getTime() - periodStart.getTime()) / 86_400_000) + 1
      : 0;
    const latestDaily = cachedDaily.at(-1);
    const dailyStale = cachedDaily.length < expectedDays
      || !latestDaily || latestDaily.date.getTime() !== trendEnd.getTime()
      || latestDaily.fetchedAt < new Date(Date.now() - DAILY_CACHE_MS);
    let freshDaily: ListingTrafficDayMetric[] = [];
    let trendError: unknown = null;
    if (dailyStale && rows.length > 0) {
      try {
        if (input.trendScope === "ACCOUNT" && client.getAccountTrafficTrend) {
          freshDaily = await client.getAccountTrafficTrend(input.userId, periodStart, trendEnd);
        } else if (client.getListingTrafficTrend) {
          freshDaily = await client.getListingTrafficTrend(input.userId, ids, periodStart, trendEnd);
        }
        const returnedByDate = new Map(freshDaily.map((point) => [point.date, point]));
        freshDaily = Array.from({ length: expectedDays }, (_, offset) => {
          const date = new Date(periodStart.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
          return returnedByDate.get(date) ?? { date, impressions: 0, views: 0 };
        });
        for (let offset = 0; offset < freshDaily.length; offset += 100) {
          await db.$transaction(freshDaily.slice(offset, offset + 100).map((point) =>
            db.ebayTrafficDailySnapshot.upsert({
              where: { userId_scopeKey_date: { userId: input.userId, scopeKey, date: day(new Date(point.date)) } },
              create: { userId: input.userId, scopeKey, date: day(new Date(point.date)), impressions: point.impressions, views: point.views, fetchedAt: new Date() },
              update: { impressions: point.impressions, views: point.views, fetchedAt: new Date() },
            }),
          ));
        }
      } catch (error) {
        trendError = error;
      }
    }
    const dailyByDate = new Map<string, ListingTrafficDayMetric>();
    for (const point of cachedDaily.map((row) => ({ date: row.date.toISOString().slice(0, 10), impressions: row.impressions, views: row.views }))) {
      const current = dailyByDate.get(point.date) ?? { date: point.date, impressions: 0, views: 0 };
      current.impressions += point.impressions;
      current.views += point.views;
      dailyByDate.set(point.date, current);
    }
    for (const point of freshDaily) dailyByDate.set(point.date, point);
    return {
      rows,
      daily: [...dailyByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
      error: rows.length === 0 && totalErrors.length
        ? trafficErrorMessage(totalErrors[0])
        : trendError
          ? cachedDaily.length ? "Showing saved traffic history; eBay's latest daily update is temporarily unavailable." : "Traffic totals are available, but eBay could not provide the daily graph right now. Your connection is still active."
          : totalErrors.length
            ? cachedTotals.length ? "Showing saved traffic totals for listings eBay could not refresh right now." : "Some older listings could not be included in traffic totals. Your eBay connection is still active."
            : null,
    };
  } catch (error) {
    if (cachedTotals.length) {
      return {
        rows: cachedTotals.map((row) => ({ ebayListingId: row.ebayListingId, impressions: row.impressions, views: row.views, clickThroughRate: row.clickThroughRate, salesConversionRate: row.salesConversionRate })),
        daily: [],
        error: "Showing saved traffic totals; eBay's latest update is temporarily unavailable.",
      };
    }
    return {
      rows: [],
      daily: [],
      error: trafficErrorMessage(error),
    };
  }
}
