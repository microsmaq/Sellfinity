import type { ProductPageScraper, ScrapedProduct } from "./scraper";
import { MockAmazonScraper } from "./mock-amazon";
import { RainforestScraper } from "./rainforest";
import type { SupplierProductState } from "@/lib/sourcing/provider";

// Real Amazon data when a Rainforest key is configured; the deterministic
// sandbox otherwise.
const scraper: ProductPageScraper = process.env.RAINFOREST_API_KEY
  ? new RainforestScraper()
  : new MockAmazonScraper();

export function getScraper(): ProductPageScraper {
  return scraper;
}

/** Nominal stock recorded for an in-stock Amazon product (Amazon doesn't
 * expose real depth); the listing cap keeps exposure small anyway. */
const NOMINAL_AMAZON_STOCK = 50;

/**
 * Supplier state for a mirrored Amazon product, via the durable shared
 * catalog. Legacy ASINs absent from that catalog trigger one provider lookup
 * and are persisted, so later sellers and syncs reuse the same snapshot.
 */
export async function amazonProductState(
  asin: string,
): Promise<SupplierProductState> {
  // Dynamic import avoids an initialization cycle: shared-catalog uses the
  // raw scraper only for a first-seen ASIN.
  const { getSharedAmazonProduct } = await import("./shared-catalog");
  const scraped = await getSharedAmazonProduct(`https://www.amazon.com/dp/${asin}`);
  if (!scraped) return null;
  return {
    stock: scraped.inStock ? NOMINAL_AMAZON_STOCK : 0,
    costCents: scraped.priceCents,
    shippingCostCents: scraped.shippingCostCents,
  };
}

export type { ScrapedProduct };
