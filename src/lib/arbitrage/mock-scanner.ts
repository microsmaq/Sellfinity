// Mock arbitrage scanner. Deterministic per day: fabricates a pool of Amazon
// products (via the same generator the mirroring sandbox uses, so mirroring
// an opportunity yields exactly the product shown) and pairs each with a
// higher-priced "best-selling" eBay listing. Only pairs that stay profitable
// after eBay fees make the list.

import { estimateMargin } from "@/lib/fees";
import {
  amazonStateForDay,
  productForAsin,
} from "@/lib/mirror/mock-amazon";
import type { ArbitrageOpportunity, ArbitrageScanner } from "./scanner";

// Safety cap: scan at most this many slots per requested opportunity, since
// some slots are filtered out (unprofitable or unsourceable today).
const SLOTS_PER_OPPORTUNITY = 4;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function currentDayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Deterministic plausible ASIN for a scan slot. */
export function asinForSlot(dayNumber: number, slot: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const rand = mulberry32(hashString(`arb:${dayNumber}:${slot}`));
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return `B0${suffix}`;
}

export class MockArbitrageScanner implements ArbitrageScanner {
  constructor(private dayNumber: () => number = currentDayNumber) {}

  async findOpportunities(count: number): Promise<ArbitrageOpportunity[]> {
    const day = this.dayNumber();
    const opportunities: ArbitrageOpportunity[] = [];
    const maxSlots = count * SLOTS_PER_OPPORTUNITY;

    for (let slot = 0; slot < maxSlots && opportunities.length < count; slot++) {
      const asin = asinForSlot(day, slot);
      const state = amazonStateForDay(asin, day);
      if (!state || state.stock === 0) continue; // can't source it today

      const product = productForAsin(asin);
      const rand = mulberry32(hashString(`arb-ebay:${asin}:${day}`));

      // The proven eBay comp sells at a 15-90% premium over the Amazon price.
      const ebayPriceCents =
        Math.round((state.costCents * (1.15 + rand() * 0.75)) / 100) * 100 - 1;
      const margin = estimateMargin(ebayPriceCents, state.costCents, 0);
      if (margin.estimatedProfitCents <= 0) continue;

      const itemId = `110${String(600_000_000 + Math.floor(rand() * 99_999_999))}`;
      const competitorCount = 4 + Math.floor(rand() * 45);
      const averageCompetitorPriceCents = Math.round(
        ebayPriceCents * (0.94 + rand() * 0.18),
      );
      opportunities.push({
        category: product.category,
        ebay: {
          itemId,
          title: product.title,
          priceCents: ebayPriceCents,
          salesLast30d: 10 + Math.floor(rand() * 140),
          url: `https://www.ebay.com/itm/${itemId}`,
          imageUrl: product.imageUrls[0],
        },
        amazon: {
          asin,
          title: product.title,
          priceCents: state.costCents,
          url: `https://www.amazon.com/dp/${asin}`,
        },
        margin,
        market: {
          estimatedSales30d: 10 + Math.floor(rand() * 140),
          competitorCount,
          averageCompetitorPriceCents,
          bestSellingPriceCents: Math.round(averageCompetitorPriceCents * 0.94),
        },
      });
    }

    return opportunities.sort(
      (a, b) => b.margin.estimatedProfitCents - a.margin.estimatedProfitCents,
    );
  }
}
