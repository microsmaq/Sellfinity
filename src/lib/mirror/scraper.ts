// Product-page scraper interface for mirroring. The mock implementation
// fabricates deterministic products from the ASIN; a real one (Amazon PA-API,
// Rainforest, Oxylabs, or a headless scraper) implements this same interface
// and is selected in src/lib/mirror/index.ts.

export type ScrapedProduct = {
  /** Marketplace product id — the ASIN for Amazon. */
  sourceId: string;
  /** Canonical product URL. */
  sourceUrl: string;
  title: string;
  brand: string;
  bulletPoints: string[];
  description: string;
  category: string;
  imageUrls: string[];
  /** Current buy price on the source marketplace (our cost when dropshipping). */
  priceCents: number;
  inStock: boolean;
};

export interface ProductPageScraper {
  /** Scrape one product page; null when the URL isn't a recognizable product. */
  scrape(url: string): Promise<ScrapedProduct | null>;
}

/**
 * Extract an ASIN from any common Amazon product URL shape:
 * /dp/ASIN, /gp/product/ASIN, /product/ASIN, with query strings, subdomains
 * (smile., www., country TLDs), and trailing path segments all tolerated.
 */
export function extractAsin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)amazon\.[a-z.]+$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(
    /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i,
  );
  return match ? match[1].toUpperCase() : null;
}
