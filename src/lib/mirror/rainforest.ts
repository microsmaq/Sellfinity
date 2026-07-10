// Real Amazon product data via the Rainforest API (rainforestapi.com).
// Selected automatically when RAINFOREST_API_KEY is set. Each scrape costs
// one API credit.

import type { ProductPageScraper, ScrapedProduct } from "./scraper";
import { extractAsin } from "./scraper";

const API_BASE = "https://api.rainforestapi.com/request";

/** The slice of Rainforest's type=product response we consume. */
export type RainforestProduct = {
  title?: string;
  brand?: string;
  description?: string;
  feature_bullets?: string[];
  main_image?: { link?: string };
  images?: { link?: string }[];
  categories?: { name?: string }[];
  buybox_winner?: {
    price?: { value?: number };
    availability?: { type?: string };
  };
};

/** Pure mapping from a Rainforest product payload to our scraper shape. */
export function mapRainforestProduct(
  asin: string,
  product: RainforestProduct,
): ScrapedProduct | null {
  const priceValue = product.buybox_winner?.price?.value;
  if (!product.title || typeof priceValue !== "number" || priceValue <= 0) {
    return null; // unbuyable/incomplete page — not mirrorable
  }
  const images = [
    product.main_image?.link,
    ...(product.images ?? []).map((i) => i.link),
  ].filter((u): u is string => typeof u === "string");

  return {
    sourceId: asin,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    title: product.title,
    brand: product.brand ?? "Unbranded",
    bulletPoints: (product.feature_bullets ?? []).slice(0, 8),
    description:
      product.description ??
      (product.feature_bullets ?? []).join(". ").slice(0, 2000),
    category: product.categories?.[0]?.name ?? "Other",
    imageUrls: [...new Set(images)].slice(0, 12),
    priceCents: Math.round(priceValue * 100),
    inStock: product.buybox_winner?.availability?.type !== "out_of_stock",
  };
}

/** One Rainforest GET; returns the parsed body or throws on HTTP failure. */
export async function rainforestRequest<T>(
  params: Record<string, string>,
): Promise<T> {
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) throw new Error("RAINFOREST_API_KEY is not set");
  const query = new URLSearchParams({
    api_key: key,
    amazon_domain: "amazon.com",
    ...params,
  });
  const res = await fetch(`${API_BASE}?${query}`);
  if (!res.ok) {
    throw new Error(`Rainforest ${params.type} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export class RainforestScraper implements ProductPageScraper {
  async scrape(url: string): Promise<ScrapedProduct | null> {
    const asin = extractAsin(url);
    if (!asin) return null;
    const data = await rainforestRequest<{
      request_info?: { success?: boolean };
      product?: RainforestProduct;
    }>({ type: "product", asin });
    if (!data.request_info?.success || !data.product) return null;
    return mapRainforestProduct(asin, data.product);
  }
}
