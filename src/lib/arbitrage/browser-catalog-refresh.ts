import { catalogImportSchema, type CatalogImportInput } from "./catalog-import";

/** Optional content travels with the price result. Never invent missing fields
 * or copy a selected sibling variant onto the requested ASIN. */
export function parseBrowserCatalogRefresh(input: unknown): CatalogImportInput | null {
  if (input === undefined || input === null) return null; // Older helpers remain price-only.
  const parsed = catalogImportSchema.safeParse(input);
  if (!parsed.success || parsed.data.source !== "BROWSER") throw new Error("Amazon product details could not be verified. Reload the helper and retry this product.");
  return parsed.data;
}

export function browserCatalogContentPatch(existing: { asin: string; amazonImportDetailsJson: string }, product: CatalogImportInput, checkedAt: Date) {
  if (existing.asin.toUpperCase() !== product.asin) throw new Error(`Amazon opened a different variant (${product.asin}) instead of ${existing.asin}. This catalog product was left unchanged.`);
  let savedDetails: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(existing.amazonImportDetailsJson || "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) savedDetails = parsed as Record<string, unknown>; } catch { /* Repair a malformed audit object, not product facts. */ }
  const bullets = product.bulletPoints.filter(Boolean);
  return {
    amazonTitle: product.title,
    amazonUrl: `https://www.amazon.com/dp/${product.asin}`,
    ...(product.brand && { amazonBrand: product.brand }),
    ...(product.category !== "Other" && { category: product.category }),
    ...(product.description.trim() && { amazonDescription: product.description }),
    ...(bullets.length && { amazonBulletPointsJson: JSON.stringify(bullets) }),
    ...(product.images.length && { amazonImageUrl: product.images[0], amazonImageUrlsJson: JSON.stringify(product.images) }),
    amazonImportDetailsJson: JSON.stringify({ ...savedDetails, availability: "AVAILABLE", ...(product.variant && { variant: product.variant }), contentCheckedAt: checkedAt.toISOString(), contentRefreshedAt: checkedAt.toISOString(), contentRefreshSource: "BROWSER" }),
  };
}
