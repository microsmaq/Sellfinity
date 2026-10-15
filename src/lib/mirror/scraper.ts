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
  /** Shipping charged by the winning Amazon offer for this exact variant. */
  shippingCostCents: number;
  inStock: boolean;
};

export interface ProductPageScraper {
  /** Scrape one product page; null when the URL isn't a recognizable product. */
  scrape(url: string): Promise<ScrapedProduct | null>;
}

/**
 * Extract an ASIN from any common Amazon product URL shape:
 * /dp/ASIN, /gp/product/ASIN, /product/ASIN, with query strings, subdomains
 * (smile., www., country TLDs), trailing path segments, and Amazon sponsored
 * links whose embedded destination is another Amazon product URL.
 */
export function extractAsin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)amazon\.[a-z.]+$/i.test(parsed.hostname)) return null;
  const productPath = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
  const match = parsed.pathname.match(productPath);
  if (match) return match[1].toUpperCase();
  if (parsed.pathname !== "/sspa/click") return null;
  // Inspect one explicit destination only. Do not follow redirects or accept
  // product-shaped paths on a non-Amazon destination.
  const destination = parsed.searchParams.get("url");
  if (!destination) return null;
  let target: URL;
  try { target = new URL(destination, parsed.origin); } catch { return null; }
  if (!/^https?:$/.test(target.protocol) || !/(^|\.)amazon\.[a-z.]+$/i.test(target.hostname)) return null;
  const targetMatch = target.pathname.match(productPath);
  return targetMatch ? targetMatch[1].toUpperCase() : null;
}
