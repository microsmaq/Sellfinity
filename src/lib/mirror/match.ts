// Find the Amazon counterpart of an arbitrary listing title. Real matching
// via Rainforest search when configured (one credit per call); deterministic
// sandbox otherwise.

import { rainforestRequest } from "./rainforest";
import { amazonStateForDay, productForAsin } from "./mock-amazon";

export type AmazonMatch = {
  asin: string;
  title: string;
  priceCents: number;
  url: string;
  imageUrl?: string;
};

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "of", "to", "in", "on",
  "new", "set", "pack", "pcs", "piece", "pieces", "free", "shipping",
]);

/** Significant lowercase tokens of a listing title. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Fraction of `a`'s significant tokens present in `b` (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  if (ta.length === 0) return 0;
  const tb = new Set(titleTokens(b));
  const hits = ta.filter((t) => tb.has(t)).length;
  return hits / ta.length;
}

const MATCH_THRESHOLD = 0.35;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic sandbox match: fabricate a stable ASIN from the title. */
function mockMatch(title: string): AmazonMatch | null {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let h = hashString(`match:${titleTokens(title).join(" ")}`);
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += alphabet[h % alphabet.length];
    h = Math.floor(h / alphabet.length) ^ (h << 5);
    h >>>= 0;
  }
  const asin = `B0${suffix}`;
  const state = amazonStateForDay(asin, Math.floor(Date.now() / 86_400_000));
  if (!state) return null;
  return {
    asin,
    title: productForAsin(asin).title,
    priceCents: state.costCents,
    url: `https://www.amazon.com/dp/${asin}`,
    imageUrl: productForAsin(asin).imageUrls[0],
  };
}

type RainforestSearchResult = {
  asin?: string;
  title?: string;
  link?: string;
  price?: { value?: number };
  image?: string;
};

/** Source-first discovery: one paid Amazon search supplies many products;
 * callers use free marketplace/local filters before buying product detail. */
export async function findAmazonCatalogProducts(
  searchTerm: string,
  page = 1,
  workflow = "amazon_catalog_discovery",
): Promise<AmazonMatch[]> {
  if (!process.env.RAINFOREST_API_KEY) {
    const match = mockMatch(searchTerm);
    return match ? [match] : [];
  }
  const normalized = titleTokens(searchTerm).slice(0, 7).join(" ");
  if (!normalized) return [];
  const data = await rainforestRequest<{
    request_info?: { success?: boolean };
    search_results?: RainforestSearchResult[];
  }>(
    { type: "search", search_term: normalized, page: String(Math.max(1, page)) },
    { workflow },
  );
  if (data.request_info?.success === false || !Array.isArray(data.search_results)) {
    throw new Error("Amazon catalog search returned an incomplete response.");
  }
  const seen = new Set<string>();
  return data.search_results.flatMap((result) => {
    if (
      !result.asin ||
      seen.has(result.asin) ||
      !result.title ||
      typeof result.price?.value !== "number" ||
      result.price.value <= 0
    ) {
      return [];
    }
    seen.add(result.asin);
    return [{
      asin: result.asin,
      title: result.title,
      priceCents: Math.round(result.price.value * 100),
      url: result.link ?? `https://www.amazon.com/dp/${result.asin}`,
      imageUrl: result.image,
    }];
  });
}

/**
 * Best title-similar Amazon product with a live price; null when nothing
 * clears the similarity threshold.
 */
export async function findAmazonMatch(
  title: string,
  options: { throwOnError?: boolean; workflow?: string } = {},
): Promise<AmazonMatch | null> {
  return (await findAmazonMatches(title, 1, options))[0] ?? null;
}

/** Ranked Amazon candidates for source repair. The caller applies the stricter
 * product-identity gate before accepting any candidate. */
export async function findAmazonMatches(
  title: string,
  limit = 5,
  options: { throwOnError?: boolean; workflow?: string } = {},
): Promise<AmazonMatch[]> {
  if (!process.env.RAINFOREST_API_KEY) {
    const match = mockMatch(title);
    return match ? [match] : [];
  }

  const searchTerm = titleTokens(title).slice(0, 7).join(" ");
  if (!searchTerm) return [];
  let results: RainforestSearchResult[];
  try {
    const data = await rainforestRequest<{
      request_info?: { success?: boolean };
      search_results?: RainforestSearchResult[];
    }>(
      { type: "search", search_term: searchTerm },
      { workflow: options.workflow ?? "amazon_match_search" },
    );
    if (
      data.request_info?.success === false ||
      !Array.isArray(data.search_results)
    ) {
      throw new Error("Amazon source search returned an incomplete response.");
    }
    results = data.search_results;
  } catch {
    if (options.throwOnError) throw new Error("Amazon source search failed.");
    return [];
  }
  const ranked = results
    .slice(0, 8)
    .map((result) => ({ result, similarity: titleSimilarity(title, result.title ?? "") }))
    .sort((a, b) => b.similarity - a.similarity);
  const matches: AmazonMatch[] = [];
  for (const { result, similarity } of ranked) {
    if (!result.asin || typeof result.price?.value !== "number") continue;
    if (result.price.value <= 0) continue;
    if (similarity < MATCH_THRESHOLD) continue;
    matches.push({
      asin: result.asin,
      title: result.title ?? title,
      priceCents: Math.round(result.price.value * 100),
      url: result.link ?? `https://www.amazon.com/dp/${result.asin}`,
      imageUrl: result.image,
    });
    if (matches.length >= Math.min(8, Math.max(1, limit))) break;
  }
  return matches;
}
