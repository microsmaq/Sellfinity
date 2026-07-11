/** Deterministic demand estimate. Real sold velocity requires eBay's
 * limited-release Marketplace Insights API. */
export function estimatedSales30d(itemId: string, priceCents: number): number {
  let hash = 2166136261;
  for (let i = 0; i < itemId.length; i++) {
    hash ^= itemId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const band = priceCents < 1500 ? 60 : priceCents < 3000 ? 40 : 25;
  return 5 + ((hash >>> 0) % band);
}
