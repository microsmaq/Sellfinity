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

/** UI row for the arbitrage table — shared by server rows builder and client table. */
export type OpportunityRow = {
  asin: string;
  category: string;
  title: string;
  imageUrl: string;
  ebayPriceCents: number;
  ebaySales30d: number;
  ebayUrl: string;
  amazonPriceCents: number;
  amazonUrl: string;
  profitCents: number;
  marginPct: number;
  feeCents: number;
  mirrored: boolean;
};

/** Ceiling on one scan — keeps "load more" from growing unbounded. */
export const MAX_OPPORTUNITIES = 500;

export interface ArbitrageScanner {
  /**
   * Today's opportunities, profitable ones only, best margin first.
   * Returns up to `count` (a larger count re-scans deeper into the same
   * day's pool, so the result is a superset of a smaller one).
   */
  findOpportunities(count: number): Promise<ArbitrageOpportunity[]>;
}
