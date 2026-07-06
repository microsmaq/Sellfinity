// Supplier / market-data provider interface. The mock implementation is the
// only one today; a real integration (CJ Dropshipping, AutoDS feed, Zik
// Analytics, etc.) implements this same interface and is selected in
// getSupplierProvider() — callers never know the difference.

export type SourcingCandidate = {
  supplierName: string;
  supplierProductId: string;
  supplierUrl: string;
  title: string;
  description: string;
  category: string;
  imageUrls: string[];
  /** Supplier unit cost. */
  costCents: number;
  /** Units the supplier currently has. */
  stock: number;
  /** Median sold price for comparable eBay listings. */
  marketPriceCents: number;
  /** Estimated cost to ship one unit to the buyer. */
  shippingCostCents: number;
  /** Comparable eBay sales per week (demand signal). */
  salesPerWeek: number;
  /** Active competing eBay listings. */
  competitorCount: number;
};

/** Live supplier state for one product; null means delisted/gone. */
export type SupplierProductState = {
  stock: number;
  costCents: number;
} | null;

export interface SupplierProvider {
  /** Today's trending/winning candidates. */
  getTrendingCandidates(): Promise<SourcingCandidate[]>;
  /** One candidate by supplier product id (for import). */
  getCandidate(supplierProductId: string): Promise<SourcingCandidate | null>;
  /** Current stock/cost for a product we already imported (for sync). */
  getProductState(supplierProductId: string): Promise<SupplierProductState>;
}
