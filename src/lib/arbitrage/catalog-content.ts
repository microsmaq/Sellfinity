type CatalogContent = { amazonDescription?: string | null; amazonTitle?: string; amazonBulletPointsJson?: string; amazonImageUrlsJson?: string; amazonImageUrl?: string | null };
export function catalogStringArray(value?: string): string[] {
  try { const parsed: unknown = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : []; } catch { return []; }
}
export function catalogContentWarnings(item: CatalogContent): string[] {
  const warnings: string[] = [];
  if (!item.amazonDescription?.trim() || item.amazonDescription.trim() === item.amazonTitle?.trim()) warnings.push("Description missing");
  if (!catalogStringArray(item.amazonBulletPointsJson).length) warnings.push("Feature bullets missing");
  if (!item.amazonImageUrl && !catalogStringArray(item.amazonImageUrlsJson).length) warnings.push("Product images missing");
  return warnings;
}
export function requireCatalogContent(item: CatalogContent) {
  const missing = catalogContentWarnings(item);
  // Features can provide useful listing copy even if Amazon has no separate description.
  if (missing.includes("Product images missing") || (missing.includes("Description missing") && missing.includes("Feature bullets missing"))) throw new Error("Complete the Amazon product content before publishing: add product images and a description or feature bullets. Re-capture the product or edit its import data.");
}
