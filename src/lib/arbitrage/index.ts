import type { ArbitrageScanner } from "./scanner";
import { MockArbitrageScanner } from "./mock-scanner";
import { RealArbitrageScanner } from "./real-scanner";
import { ebayEnvConfig } from "@/lib/ebay/oauth";

/**
 * Real scan (eBay Browse + Rainforest) when both a Rainforest key and a
 * production eBay keyset are configured — sandbox Browse data is junk, so
 * local dev (SANDBOX) keeps the deterministic mock.
 */
export function getArbitrageScanner(): ArbitrageScanner {
  if (process.env.RAINFOREST_API_KEY && ebayEnvConfig()?.env === "PRODUCTION") {
    return new RealArbitrageScanner();
  }
  return new MockArbitrageScanner();
}
