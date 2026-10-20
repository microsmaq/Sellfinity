/** Pure Keepa decoding. Never infer free shipping or marketplace availability. */
export type KeepaObject = Record<string, unknown>;
export const asObject = (value: unknown): KeepaObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as KeepaObject : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
export const validAsin = (value: unknown): value is string => typeof value === "string" && /^[A-Z0-9]{10}$/.test(value);

export function keepaDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date((value + 21564000) * 60000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function bestsellerAsins(response: unknown): string[] {
  const list = asObject(asObject(response).bestSellersList).asinList;
  // Preserve rank/order; duplicate removal happens against the durable ASIN key.
  return Array.isArray(list) ? list.filter(validAsin) : [];
}

export function rootCategories(response: unknown) {
  const raw = asObject(response).categories;
  const categories = Array.isArray(raw) ? raw : Object.values(asObject(raw));
  return categories.flatMap((value) => {
    const row = asObject(value), id = String(row.catId ?? ""), name = text(row.name);
    return /^\d{1,18}$/.test(id) && name ? [{ id, name }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function automaticKeepaCategories(categories: { id: string; name: string }[]) {
  // This catalog supplies physical eBay goods, not digital downloads/apps.
  return categories.filter((row) => !/kindle|digital|audible|apps|software|prime video|instant video/i.test(row.name));
}

export function keepaCatalogData(product: KeepaObject, source: { asin: string; categoryId: string; categoryName: string; bestsellerRank: number; fetchedAt: Date | null }) {
  if (product.asin !== source.asin || product.domainId !== 1 || product.productType !== 0 || text(product.title).length < 3) return null;
  const filenames = Array.isArray(product.images)
    ? product.images.map((image) => text(asObject(image).l) || text(asObject(image).m))
    : text(product.imagesCSV).split(",");
  const images = [...new Set(filenames.filter((file) => /^[A-Za-z0-9+_.%\-]+\.(?:jpg|jpeg|png|webp)$/i.test(file)))]
    .slice(0, 12).map((file) => `https://m.media-amazon.com/images/I/${file}`);
  const stats = asObject(product.stats);
  const current = Array.isArray(stats.current) ? stats.current : [];
  const price = [current[0], current[1]].find((value) => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1_000_000);
  const description = text(product.description) || text(product.shortDescription);
  const bullets = strings(product.features).slice(0, 15);
  const categoryTree = Array.isArray(product.categoryTree) ? product.categoryTree : [];
  const category = text(asObject(categoryTree.at(-1)).name) || source.categoryName;
  const missing = [!description && "Description", !bullets.length && "Features", !images.length && "Images", !price && "Current price", "Verified shipping and availability"].filter(Boolean);
  return {
    asin: source.asin, amazonTitle: text(product.title).slice(0, 1000),
    amazonBrand: text(product.brand).slice(0, 200), category: category.slice(0, 200),
    amazonUrl: `https://www.amazon.com/dp/${source.asin}`,
    amazonPriceCents: typeof price === "number" ? price : 0,
    amazonShippingCents: 0, amazonShippingVerified: false, amazonInStock: false,
    // Import time is not source-price freshness. Unknown dates remain unknown.
    amazonRefreshedAt: keepaDate(product.lastUpdate),
    amazonImageUrl: images[0] ?? null, amazonImageUrlsJson: JSON.stringify(images),
    amazonDescription: description.slice(0, 10000), amazonBulletPointsJson: JSON.stringify(bullets),
    isAmazonBestSeller: true, status: "PENDING", matchVerdict: "UNVERIFIED", matchConfidence: 0,
    matchMethod: "UNVERIFIED", matchReason: "Keepa bestseller import; verify source shipping/stock and research the equivalent eBay product before publishing.",
    amazonImportDetailsJson: JSON.stringify({ source: "KEEPA", importedAt: source.fetchedAt?.toISOString(),
      domain: 1, bestsellerCategory: source.categoryName, bestsellerCategoryId: source.categoryId,
      bestsellerRank: source.bestsellerRank, availability: "UNKNOWN", shippingCents: null,
      missingDetails: missing, variant: [text(product.model), text(product.color), text(product.size)].filter(Boolean).join(" · "),
      // Complete provider response is retained once, on KeepaDiscoveryItem.
      keepaSnapshotAsin: source.asin, providerLastUpdate: keepaDate(product.lastUpdate)?.toISOString() }),
  };
}

export function availableKeepaTokens(state: { tokensLeft: number | null; tokenSampleAt: Date | null; refillRate: number }, now: Date) {
  if (state.tokensLeft === null || !state.tokenSampleAt) return null;
  // Conservative whole-minute refills; never assume a faster plan than 20/min.
  const rate = Math.max(0, Math.min(20, state.refillRate));
  return Math.min(rate * 60, Math.max(0, state.tokensLeft + Math.max(0, Math.floor((now.getTime() - state.tokenSampleAt.getTime()) / 60000)) * rate));
}
