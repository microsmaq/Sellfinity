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
 * Supplier state for a mirrored Amazon product, via the active scraper —
 * used by inventory sync. With the real scraper this costs one API credit
 * per product per sync.
 */
export async function amazonProductState(
  asin: string,
): Promise<SupplierProductState> {
  const scraped = await scraper.scrape(`https://www.amazon.com/dp/${asin}`);
  if (!scraped) return null;
  return {
    stock: scraped.inStock ? NOMINAL_AMAZON_STOCK : 0,
    costCents: scraped.priceCents,
  };
}

export type { ScrapedProduct };
