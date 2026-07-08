// Cross-marketplace arbitrage scanner: best-selling eBay products that have
// a matching Amazon product selling for less. The mock implementation is the
// only one today; a real one combines the eBay Browse/Marketplace Insights
// APIs (top sellers per category) with an Amazon product-search API, matched
// by title/UPC, and is selected in src/lib/arbitrage/index.ts.

import type { MarginEstimate } from "@/lib/fees";

export type ArbitrageOpportunity = {
  category: string;
  /** The proven seller on eBay. */
  ebay: {
    itemId: string;
    title: string;
    priceCents: number;
    salesLast30d: number;
    url: string;
    imageUrl: string;
  };
  /** The cheaper source listing on Amazon. */
  amazon: {
    asin: string;
    title: string;
    priceCents: number;
    url: string;
  };
  /** Selling at the eBay price, buying at the Amazon price, net of eBay fees. */
  margin: MarginEstimate;
};

export interface ArbitrageScanner {
  /** Today's opportunities, profitable ones only, best margin first. */
  findOpportunities(): Promise<ArbitrageOpportunity[]>;
}
