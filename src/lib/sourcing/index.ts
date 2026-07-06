import type { SupplierProductState, SupplierProvider } from "./provider";
import { MockSupplierProvider } from "./mock-supplier";
import { amazonStateForDay } from "@/lib/mirror/mock-amazon";

// Swap point for real supplier/market-data integrations: replace either
// branch (feed supplier, Amazon state lookups) and the rest of the app
// follows.

const megaSupply = new MockSupplierProvider();

function currentDayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/**
 * Routes by supplier product id: the sourcing feed comes from the wholesale
 * supplier; product-state lookups (inventory sync) also cover mirrored Amazon
 * products, whose ids are ASINs (10 alphanumerics) rather than MS-xxxx.
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
      return amazonStateForDay(supplierProductId, currentDayNumber());
    }
    return megaSupply.getProductState(supplierProductId);
  }
}

const provider: SupplierProvider = new RoutingSupplierProvider();

export function getSupplierProvider(): SupplierProvider {
  return provider;
}
