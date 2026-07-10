// Scheduled research scan (see vercel.json crons). Vercel invokes this with
// "Authorization: Bearer <CRON_SECRET>" when the env var is set.

import { NextResponse } from "next/server";
import { scanMore } from "@/lib/arbitrage";

export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const report = await scanMore({ target: 50, timeBudgetMs: 50_000 });
  console.log(
    `cron arbitrage scan: +${report.added} added, ${report.examined} examined, exhausted=${report.exhausted}`,
  );
  return NextResponse.json(report);
}
