import type { ArbitrageScanner } from "./scanner";
import { MockArbitrageScanner } from "./mock-scanner";

// Swap point for a real scanner (eBay Browse/Marketplace Insights + an
// Amazon product-search API): return a different implementation here.
const scanner: ArbitrageScanner = new MockArbitrageScanner();

export function getArbitrageScanner(): ArbitrageScanner {
  return scanner;
}
