import { EBAY_TITLE_MAX } from "@/lib/listings/generate";
import type { ScrapedProduct } from "./scraper";

// Suffixes buyers actually search, in priority order; the first that fits is
// appended.
const SEO_SUFFIXES = [" - Brand New", " NEW"];

function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut.slice(0, max)).trim();
}

/**
 * eBay-search-optimized title from a scraped product: keyword-dense source
 * title (brand + product + attributes), a condition keyword when it fits,
 * hard-capped at eBay's 80 characters on a word boundary.
 */
export function generateSeoTitle(scraped: Pick<ScrapedProduct, "title">): string {
  const base = scraped.title.replace(/\s+/g, " ").trim();
  for (const suffix of SEO_SUFFIXES) {
    if (base.length + suffix.length <= EBAY_TITLE_MAX) return base + suffix;
  }
  return truncateAtWord(base, EBAY_TITLE_MAX);
}

/** Listing description assembled from the scraped bullet points. */
export function generateMirrorDescription(
  scraped: Pick<ScrapedProduct, "title" | "bulletPoints" | "category">,
): string {
  return [
    scraped.title,
    "",
    ...scraped.bulletPoints.map((b) => `✔ ${b}`),
    "",
    "✔ Brand new in original packaging",
    "✔ Ships within 1 business day with tracking",
    "✔ 30-day hassle-free returns",
    "",
    `Category: ${scraped.category}. Questions? Message us — we reply fast.`,
  ].join("\n");
}
