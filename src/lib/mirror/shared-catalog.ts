import { db } from "@/lib/db";
import { parseImageUrls, serializeImageUrls } from "@/lib/types";
import { getScraper } from "./index";
import {
  extractAsin,
  type ProductPageScraper,
  type ScrapedProduct,
} from "./scraper";

type SharedAmazonRow = {
  asin: string;
  amazonTitle: string;
  amazonPriceCents: number;
  amazonShippingCents: number;
  amazonUrl: string;
  amazonImageUrl: string | null;
  amazonBrand: string;
  amazonDescription: string;
  amazonBulletPointsJson: string;
  amazonImageUrlsJson: string;
  amazonInStock: boolean;
  category: string;
};

function stringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** Convert the durable shared catalog snapshot into the generic mirroring shape. */
export function sharedRowToScrapedProduct(row: SharedAmazonRow): ScrapedProduct {
  const storedImages = stringArray(row.amazonImageUrlsJson);
  const imageUrls = [...new Set([
    ...storedImages,
    ...(row.amazonImageUrl ? [row.amazonImageUrl] : []),
  ])];
  return {
    sourceId: row.asin,
    sourceUrl: row.amazonUrl,
    title: row.amazonTitle,
    brand: row.amazonBrand,
    bulletPoints: stringArray(row.amazonBulletPointsJson),
    description: row.amazonDescription || row.amazonTitle,
    category: row.category,
    imageUrls,
    priceCents: row.amazonPriceCents,
    shippingCostCents: row.amazonShippingCents,
    inStock: row.amazonInStock,
  };
}

/** Fields every paid Amazon product lookup persists for reuse by all sellers. */
export function sharedAmazonSnapshotData(product: ScrapedProduct) {
  return {
    amazonTitle: product.title,
    amazonPriceCents: product.priceCents,
    amazonShippingCents: product.shippingCostCents,
    amazonUrl: product.sourceUrl,
    amazonImageUrl: product.imageUrls[0] ?? null,
    amazonBrand: product.brand,
    amazonDescription: product.description,
    amazonBulletPointsJson: JSON.stringify(product.bulletPoints),
    amazonImageUrlsJson: serializeImageUrls(product.imageUrls),
    amazonInStock: product.inStock,
    amazonRefreshedAt: new Date(),
    category: product.category || "Other",
  };
}

export type SharedAmazonLookupOptions = {
  /** Skip legacy seller snapshots when the shared admin row is missing or
   * unusable, and obtain one provider-backed snapshot for the global cache. */
  providerOnCatalogMiss?: boolean;
};

/**
 * Shared-first Amazon lookup used by seller workflows.
 *
 * Existing ASINs are served entirely from Postgres. Only the first lookup of
 * an unknown ASIN reaches the configured provider, after which the complete
 * response is retained in AdminArbitrageProduct for every future seller.
 */
export async function getSharedAmazonProduct(
  url: string,
  options: SharedAmazonLookupOptions = {},
): Promise<ScrapedProduct | null> {
  const normalizedUrl = /^[A-Z0-9]{10}$/i.test(url.trim())
    ? `https://www.amazon.com/dp/${url.trim().toUpperCase()}`
    : url;
  const asin = extractAsin(normalizedUrl);
  if (!asin) return null;

  const existing = await db.adminArbitrageProduct.findUnique({ where: { asin } });
  if (existing) {
    const stored = sharedRowToScrapedProduct(existing);
    const usableSnapshot = stored.priceCents > 0 && stored.imageUrls.length > 0;
    if (usableSnapshot) return stored.inStock ? stored : null;
    if (!options.providerOnCatalogMiss && (!stored.inStock || stored.priceCents <= 0)) return null;

    // Rows created before complete shared snapshots were introduced can have
    // incomplete Amazon data. Enrich that ASIN once on demand instead of
    // leaving pricing/image workflows without a usable shared snapshot.
    const enriched = await getScraper().scrape(existing.amazonUrl || normalizedUrl);
    if (!enriched || enriched.imageUrls.length === 0) return null;
    const saved = await db.adminArbitrageProduct.upsert({
      where: { asin },
      create: {
        asin,
        ...sharedAmazonSnapshotData(enriched),
        isAmazonBestSeller: false,
        status: "PENDING",
      },
      update: sharedAmazonSnapshotData(enriched),
    });
    return sharedRowToScrapedProduct(saved);
  }

  // Lazily promote legacy per-user imports into the shared catalog without
  // spending a provider credit. Product contains supplier facts only; no
  // seller identity or listing data is copied.
  const legacy = options.providerOnCatalogMiss ? null : await db.product.findFirst({
    where: {
      supplierName: "Amazon",
      OR: [{ sku: asin }, { supplierProductId: asin }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (legacy && parseImageUrls(legacy.imageUrlsJson).length > 0) {
    const legacyProduct: ScrapedProduct = {
      sourceId: asin,
      sourceUrl: legacy.supplierUrl,
      title: legacy.title,
      brand: legacy.brand,
      bulletPoints: [],
      description: legacy.description,
      category: legacy.category,
      imageUrls: parseImageUrls(legacy.imageUrlsJson),
      priceCents: legacy.costCents,
      shippingCostCents: legacy.shippingCostCents,
      inStock: legacy.supplierStock > 0,
    };
    const saved = await db.adminArbitrageProduct.upsert({
      where: { asin },
      create: {
        asin,
        ...sharedAmazonSnapshotData(legacyProduct),
        isAmazonBestSeller: false,
        status: "PENDING",
      },
      update: sharedAmazonSnapshotData(legacyProduct),
    });
    const stored = sharedRowToScrapedProduct(saved);
    return stored.inStock && stored.priceCents > 0 ? stored : null;
  }

  const product = await getScraper().scrape(normalizedUrl);
  if (!product || product.imageUrls.length === 0) return null;
  const snapshot = sharedAmazonSnapshotData(product);
  const saved = await db.adminArbitrageProduct.upsert({
    where: { asin: product.sourceId },
    create: {
      asin: product.sourceId,
      ...snapshot,
      isAmazonBestSeller: false,
      status: "PENDING",
    },
    // A concurrent first import may have created the row while the provider
    // request was in flight. Preserve its admin/eBay state and refresh only
    // the shared Amazon snapshot.
    update: snapshot,
  });
  return sharedRowToScrapedProduct(saved);
}

export const sharedCatalogScraper: ProductPageScraper = {
  scrape: (url) => getSharedAmazonProduct(url, { providerOnCatalogMiss: true }),
};
