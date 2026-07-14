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

/**
 * Best title-similar Amazon product with a live price; null when nothing
 * clears the similarity threshold.
 */
export async function findAmazonMatch(title: string): Promise<AmazonMatch | null> {
  if (!process.env.RAINFOREST_API_KEY) return mockMatch(title);

  const searchTerm = titleTokens(title).slice(0, 7).join(" ");
  if (!searchTerm) return null;
  let results: RainforestSearchResult[];
  try {
    const data = await rainforestRequest<{
      search_results?: RainforestSearchResult[];
    }>({ type: "search", search_term: searchTerm });
    results = data.search_results ?? [];
  } catch {
    return null;
  }
  const ranked = results
    .slice(0, 8)
    .map((result) => ({ result, similarity: titleSimilarity(title, result.title ?? "") }))
    .sort((a, b) => b.similarity - a.similarity);
  for (const { result, similarity } of ranked) {
    if (!result.asin || typeof result.price?.value !== "number") continue;
    if (result.price.value <= 0) continue;
    if (similarity < MATCH_THRESHOLD) continue;
    return {
      asin: result.asin,
      title: result.title ?? title,
      priceCents: Math.round(result.price.value * 100),
      url: result.link ?? `https://www.amazon.com/dp/${result.asin}`,
      imageUrl: result.image,
    };
  }
  return null;
}
