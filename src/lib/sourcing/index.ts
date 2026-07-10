import type { SupplierProductState, SupplierProvider } from "./provider";
import { MockSupplierProvider } from "./mock-supplier";
import { amazonProductState } from "@/lib/mirror";

// Swap point for real supplier/market-data integrations: replace either
// branch (feed supplier, Amazon state lookups) and the rest of the app
// follows.

const megaSupply = new MockSupplierProvider();

/**
 * Routes by supplier product id: the sourcing feed comes from the wholesale
 * supplier; product-state lookups (inventory sync) also cover mirrored Amazon
 * products, whose ids are ASINs (10 alphanumerics) rather than MS-xxxx.
 * Amazon lookups go through the active scraper (real when Rainforest is
 * configured, sandbox otherwise).
 */
class RoutingSupplierProvider implements SupplierProvider {
  getTrendingCandidates() {
    return megaSupply.getTrendingCandidates();
  }

  getCandidate(supplierProductId: string) {
    return megaSupply.getCandidate(supplierProductId);
  }

  async getProductState(supplierProductId: string): Promise<SupplierProductState> {
    if (/^[A-Z0-9]{10}$/.test(supplierProductId)) {
      return amazonProductState(supplierProductId);
    }
    return megaSupply.getProductState(supplierProductId);
  }
}

const provider: SupplierProvider = new RoutingSupplierProvider();

export function getSupplierProvider(): SupplierProvider {
  return provider;
}
