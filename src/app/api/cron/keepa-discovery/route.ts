import { NextRequest, NextResponse } from "next/server";
import { advanceKeepaDiscovery, recordKeepaSchedulerHeartbeat, type KeepaStep } from "@/lib/keepa/discovery";
import { keepaRunTelemetry } from "@/lib/keepa/reporting";

export const maxDuration = 180;
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const startedAt = new Date();
  await recordKeepaSchedulerHeartbeat();
  // Vercel Pro invokes this every minute. Drain productive units only; return
  // immediately on refill waits, pauses, completion or an overlapping worker.
  // A request already started may take up to 50s beyond this 40s soft deadline.
  const deadline = Date.now() + 40000;
  let steps = 0, outcome: KeepaStep = "IDLE";
  while (steps < 80 && Date.now() < deadline) {
    outcome = await advanceKeepaDiscovery();
    steps++;
    if (outcome !== "PROGRESSED") break;
  }
  const telemetry = await keepaRunTelemetry(startedAt);
  console.info("[keepa-discovery]", JSON.stringify({ steps, outcome, ...telemetry }));
  return NextResponse.json({ ok: outcome !== "ERROR", steps, outcome, ...telemetry });
}
