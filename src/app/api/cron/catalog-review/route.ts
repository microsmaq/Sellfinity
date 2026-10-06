import { NextResponse } from "next/server";
import { runAutomaticCatalogReview } from "@/lib/arbitrage/automatic-review";
export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runAutomaticCatalogReview();
  console.log("Automatic catalog review", result);
  return NextResponse.json(result);
}
