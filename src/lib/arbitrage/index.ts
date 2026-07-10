import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { MockArbitrageScanner } from "./mock-scanner";
import { realScanMore } from "./real-scanner";
import { persistOpportunities } from "./store";
import type { ScanReport } from "./scan-types";

function isRealScan(): boolean {
  return Boolean(
    process.env.RAINFOREST_API_KEY && ebayEnvConfig()?.env === "PRODUCTION",
  );
}

const MOCK_STEP = 25;

/** Sandbox scan: deterministically extend the research database. Requires an
 * explicit opt-in — a dev machine pointed at the production database must
 * not seed it with fabricated items. */
async function mockScanMore(): Promise<ScanReport> {
  if (process.env.ALLOW_MOCK_SCAN !== "1") {
    return { added: 0, examined: 0, exhausted: true };
  }
  const cursorKey = "arbitrage:mock-cursor";
  const row = await db.scanCache.findUnique({ where: { cacheKey: cursorKey } });
  const count = row ? (JSON.parse(row.dataJson) as { count: number }).count : 0;
  const next = count + MOCK_STEP;
  const opportunities = await new MockArbitrageScanner().findOpportunities(next);
  const added = await persistOpportunities(opportunities);
  const exhausted = opportunities.length < next;
  await db.scanCache.upsert({
    where: { cacheKey: cursorKey },
    create: { cacheKey: cursorKey, dataJson: JSON.stringify({ count: next }) },
    update: { dataJson: JSON.stringify({ count: next }) },
  });
  return { added, examined: MOCK_STEP, exhausted };
}

/**
 * Advance the research scan (real APIs on production with a Rainforest key,
 * deterministic sandbox otherwise). New matches land in ArbitrageItem.
 */
export async function scanMore(timeBudgetMs?: number): Promise<ScanReport> {
  return isRealScan() ? realScanMore(timeBudgetMs) : mockScanMore();
}
