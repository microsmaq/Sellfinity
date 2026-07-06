import type { ProductPageScraper } from "./scraper";
import { MockAmazonScraper } from "./mock-amazon";

// Swap point for a real scraping backend (Amazon PA-API, Rainforest API,
// Oxylabs, etc.): return a different ProductPageScraper here and the mirror
// pipeline follows.
const scraper: ProductPageScraper = new MockAmazonScraper();

export function getScraper(): ProductPageScraper {
  return scraper;
}
