// Listing generator: turns an imported product into ready-to-publish eBay
// listing content. Deterministic template today; the generate* functions are
// the swap point for LLM-written copy later (same inputs, same outputs shape).

export const EBAY_TITLE_MAX = 80;

/** How many units to expose on eBay at once — a small buffer limits oversell
 * risk when supplier stock moves between syncs. */
export const LISTING_QUANTITY_CAP = 5;

const TITLE_SUFFIX = " - Fast Free Shipping";

export type ListingContent = {
  title: string;
  description: string;
  priceCents: number;
  quantity: number;
  imageUrls: string[];
};

export type GeneratorInput = {
  title: string;
  description: string;
  category: string;
  imageUrls: string[];
  suggestedPriceCents: number;
  supplierStock: number;
};

/** Truncate at a word boundary to fit eBay's title limit. */
export function generateTitle(productTitle: string): string {
  const withSuffix = productTitle + TITLE_SUFFIX;
  if (withSuffix.length <= EBAY_TITLE_MAX) return withSuffix;
  if (productTitle.length <= EBAY_TITLE_MAX) return productTitle;
  const cut = productTitle.slice(0, EBAY_TITLE_MAX + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut.slice(0, EBAY_TITLE_MAX)).trim();
}

export function generateDescription(input: {
  title: string;
  description: string;
  category: string;
}): string {
  return [
    input.title,
    "",
    input.description,
    "",
    "✔ Brand new in original packaging",
    "✔ Ships within 1 business day with tracking",
    "✔ 30-day hassle-free returns",
    "",
    `Category: ${input.category}. Questions? Message us — we reply fast.`,
  ].join("\n");
}

export function generateListing(input: GeneratorInput): ListingContent {
  return {
    title: generateTitle(input.title),
    description: generateDescription(input),
    priceCents: input.suggestedPriceCents,
    quantity: Math.min(LISTING_QUANTITY_CAP, input.supplierStock),
    imageUrls: input.imageUrls,
  };
}
