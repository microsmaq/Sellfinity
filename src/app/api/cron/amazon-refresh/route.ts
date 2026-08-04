import { NextResponse } from "next/server";
import { refreshPrioritizedAmazonCatalog } from "@/lib/arbitrage/amazon-refresh-policy";
import {
  AMAZON_REFRESH_CRON_HOUR,
  ARBITRAGE_CRON_TIME_ZONE,
  getLosAngelesCronTime,
  shouldRunDailyAmazonRefreshCron,
} from "@/lib/cron/arbitrage-schedule";

export const maxDuration = 300;

const REFRESH_TIME_BUDGET_MS = 275_000;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const localTime = getLosAngelesCronTime(now);
  if (!shouldRunDailyAmazonRefreshCron(now)) {
    return NextResponse.json({
      skipped: true,
      reason: `The prioritized Amazon refresh only runs at ${AMAZON_REFRESH_CRON_HOUR} AM ${ARBITRAGE_CRON_TIME_ZONE}.`,
      localTime,
    });
  }

  const refresh = await refreshPrioritizedAmazonCatalog({
    now,
    maxItems: 100,
    timeBudgetMs: REFRESH_TIME_BUDGET_MS,
  });
  console.log(
    `cron Amazon refresh: ${refresh.succeeded}/${refresh.processed} succeeded, ${refresh.remaining} deferred; tiers=${JSON.stringify(refresh.tiers)}`,
  );
  return NextResponse.json({ localDate: localTime.date, refresh });
}

