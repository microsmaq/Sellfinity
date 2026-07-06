// Mock supplier provider. Deterministic per (product, day): the feed and
// supplier stock/cost drift daily, so inventory sync has real work to do and
// results are reproducible within a day (important for import-by-id and tests).

import type {
  SourcingCandidate,
  SupplierProductState,
  SupplierProvider,
} from "./provider";
import { CATALOG, SUPPLIER_NAME, type CatalogItem } from "./catalog";

/** Days since epoch, UTC — the drift seed changes at midnight UTC. */
export function currentDayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: returns a function yielding floats in [0,1). */
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

type DriftedState = {
  stock: number;
  costCents: number;
  salesPerWeek: number;
  competitorCount: number;
  gone: boolean;
};

/** Deterministic daily supplier state for a catalog item. */
export function driftedState(item: CatalogItem, dayNumber: number): DriftedState {
  const rand = mulberry32(hashString(`${item.id}:${dayNumber}`));

  // ~3% of products disappear from the supplier on any given day.
  const gone = rand() < 0.03;
  // ~10% are out of stock; otherwise stock swings ±60% around base.
  const outOfStock = rand() < 0.1;
  const stock = gone || outOfStock ? 0 : Math.round(item.baseStock * (0.4 + rand() * 1.2));
  // Cost swings ±12% around base (suppliers reprice constantly).
  const costCents = Math.round(item.baseCostCents * (0.88 + rand() * 0.24));
  // Demand swings ±40%; competition ±30%.
  const salesPerWeek = Math.max(1, Math.round(item.baseSalesPerWeek * (0.6 + rand() * 0.8)));
  const competitorCount = Math.max(1, Math.round(item.baseCompetitorCount * (0.7 + rand() * 0.6)));

  return { stock, costCents, salesPerWeek, competitorCount, gone };
}

function toCandidate(item: CatalogItem, dayNumber: number): SourcingCandidate | null {
  const state = driftedState(item, dayNumber);
  if (state.gone) return null;
  return {
    supplierName: SUPPLIER_NAME,
    supplierProductId: item.id,
    supplierUrl: `https://supplier.example.com/products/${item.id}`,
    title: item.title,
    description: item.description,
    category: item.category,
    imageUrls: [
      `https://picsum.photos/seed/${item.id}-a/600/600`,
      `https://picsum.photos/seed/${item.id}-b/600/600`,
    ],
    costCents: state.costCents,
    stock: state.stock,
    marketPriceCents: item.baseMarketPriceCents,
    shippingCostCents: item.shippingCostCents,
    salesPerWeek: state.salesPerWeek,
    competitorCount: state.competitorCount,
  };
}

export class MockSupplierProvider implements SupplierProvider {
  constructor(private dayNumber: () => number = currentDayNumber) {}

  async getTrendingCandidates(): Promise<SourcingCandidate[]> {
    const day = this.dayNumber();
    return CATALOG.map((item) => toCandidate(item, day)).filter(
      (c): c is SourcingCandidate => c !== null,
    );
  }

  async getCandidate(supplierProductId: string): Promise<SourcingCandidate | null> {
    const item = CATALOG.find((i) => i.id === supplierProductId);
    if (!item) return null;
    return toCandidate(item, this.dayNumber());
  }

  async getProductState(supplierProductId: string): Promise<SupplierProductState> {
    const item = CATALOG.find((i) => i.id === supplierProductId);
    if (!item) return null;
    const state = driftedState(item, this.dayNumber());
    if (state.gone) return null;
    return { stock: state.stock, costCents: state.costCents };
  }
}
