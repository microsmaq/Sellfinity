// Scheduled research scan (see vercel.json crons). Vercel invokes this with
// "Authorization: Bearer <CRON_SECRET>" when the env var is set.

import { NextResponse } from "next/server";
import { scanMore } from "@/lib/arbitrage";
import { processAutomaticArbitrageBatchesUntil } from "@/lib/actions/mirror-batches";
import {
  ARBITRAGE_CRON_TIME_ZONE,
  ARBITRAGE_DAILY_TARGET,
  getLosAngelesCronTime,
  shouldRunDailyArbitrageCron,
} from "@/lib/cron/arbitrage-schedule";

export const maxDuration = 300;

const SCAN_TIME_BUDGET_MS = 240_000;
const JOB_TIME_BUDGET_MS = 290_000;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date(startedAt);
  const localTime = getLosAngelesCronTime(now);
  if (!shouldRunDailyArbitrageCron(now)) {
    return NextResponse.json({
      skipped: true,
      reason: `The daily scan only runs at 3 AM ${ARBITRAGE_CRON_TIME_ZONE}.`,
      localTime,
    });
  }

  const scan = await scanMore({
    target: ARBITRAGE_DAILY_TARGET,
    timeBudgetMs: SCAN_TIME_BUDGET_MS,
  });
  const publishing = await processAutomaticArbitrageBatchesUntil(
    startedAt + JOB_TIME_BUDGET_MS,
    secret,
  );
  console.log(
    `cron arbitrage scan: +${scan.added}/${ARBITRAGE_DAILY_TARGET} added, ${scan.examined} examined, exhausted=${scan.exhausted}; auto-publish: ${publishing.itemsProcessed} processed for ${publishing.optedInUsers} users`,
  );
  return NextResponse.json({
    target: ARBITRAGE_DAILY_TARGET,
    localDate: localTime.date,
    scan,
    publishing,
  });
}
