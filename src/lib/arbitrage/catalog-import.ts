import { z } from "zod";

const amazonUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && /^(?:www\.)?amazon\.com$/.test(url.hostname);
}, "Use an https://www.amazon.com URL.");
export const catalogImportSchema = z.object({
  asin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/),
  title: z.string().trim().min(3).max(1000),
  brand: z.string().trim().max(200).default(""),
  category: z.string().trim().min(1).max(200),
  variant: z.string().trim().max(500).default(""),
  priceCents: z.number().int().min(0).max(1_000_000),
  shippingCents: z.number().int().min(0).max(100_000).nullable(),
  availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]),
  images: z.array(z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)(?:media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com)$/.test(url.hostname);
  }, "Use Amazon image URLs.")).max(12).default([]),
  bulletPoints: z.array(z.string().trim().max(2000)).max(15).default([]),
  description: z.string().max(10000).default(""),
  source: z.enum(["MANUAL", "CSV", "BROWSER", "BESTSELLER_BROWSER"]),
  sourceUrl: amazonUrl,
  bestsellerRank: z.number().int().min(1).max(1_000_000).nullable().default(null),
  bestsellerCategory: z.string().trim().max(200).default(""),
  bestsellerUrl: amazonUrl.nullable().default(null),
}).superRefine((row, context) => {
  const urlAsin = row.sourceUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase();
  if (urlAsin !== row.asin) context.addIssue({ code: "custom", path: ["sourceUrl"], message: "Product URL must match the ASIN." });
  if (row.availability === "AVAILABLE" && row.priceCents <= 0) context.addIssue({ code: "custom", path: ["priceCents"], message: "Available products need a current price." });
  if (row.bestsellerRank && !row.bestsellerUrl) context.addIssue({ code: "custom", path: ["bestsellerUrl"], message: "Record the bestseller source page for the rank." });
});
export type CatalogImportInput = z.infer<typeof catalogImportSchema>;

/** CSV supports quoted commas, escaped quotes and multiline descriptions. */
export function parseCatalogCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field); if (row.some((value) => value.trim())) rows.push(row);
      row = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  row.push(field); if (row.some((value) => value.trim())) rows.push(row);
  const headers = rows.shift()?.map((value) => value.trim()) ?? [];
  if (headers.length !== new Set(headers).size) throw new Error("CSV has duplicate column names.");
  if (rows.some((values) => values.length !== headers.length)) throw new Error("CSV rows must match the number of columns.");
  return rows.map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i]])));
}

export function catalogCsvInputs(text: string): CatalogImportInput[] {
  return parseCatalogCsv(text).map((row) => catalogImportSchema.parse({
    ...row,
    priceCents: Math.round(Number(row.price) * 100),
    shippingCents: row.shipping?.trim() ? Math.round(Number(row.shipping) * 100) : null,
    availability: row.availability?.toUpperCase() || "UNKNOWN",
    source: "CSV",
    sourceUrl: row.sourceUrl || `https://www.amazon.com/dp/${row.asin?.trim().toUpperCase()}`,
    images: row.images ? row.images.split("|").filter(Boolean) : [],
    bestsellerRank: row.bestsellerRank ? Number(row.bestsellerRank) : null,
    bestsellerUrl: row.bestsellerUrl || null,
  }));
}
