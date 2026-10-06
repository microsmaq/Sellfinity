import { describe, expect, it } from "vitest";
import { catalogCsvInputs, catalogImportSchema, parseCatalogCsv } from "@/lib/arbitrage/catalog-import";
const product = { asin: "B012345678", title: "Test product", category: "Home", priceCents: 1299, shippingCents: null, availability: "AVAILABLE", source: "MANUAL", sourceUrl: "https://www.amazon.com/dp/B012345678" };
describe("no-credit catalog import", () => {
  it("keeps unknown shipping separate from verified free shipping", () => {
    expect(catalogImportSchema.parse(product).shippingCents).toBeNull();
    expect(catalogImportSchema.parse({ ...product, shippingCents: 0 }).shippingCents).toBe(0);
  });
  it("requires product identity and bestseller provenance", () => {
    expect(catalogImportSchema.safeParse({ ...product, sourceUrl: "https://www.amazon.com/dp/B099999999" }).success).toBe(false);
    expect(catalogImportSchema.safeParse({ ...product, bestsellerRank: 1 }).success).toBe(false);
    expect(catalogImportSchema.safeParse({ ...product, images: ["https://attacker.example/image.jpg"] }).success).toBe(false);
  });
  it("parses quoted titles and multiline fields without corrupting columns", () => {
    expect(parseCatalogCsv('title,description\n"Tool, blue","Line 1\nLine 2 with ""quotes"""')).toEqual([{ title: "Tool, blue", description: 'Line 1\nLine 2 with "quotes"' }]);
  });
  it("imports dollars as cents and leaves blank shipping unknown", () => {
    const rows = catalogCsvInputs('asin,title,category,price,shipping,availability\nB012345678,Test product,Home,12.99,,AVAILABLE');
    expect(rows[0]).toMatchObject({ priceCents: 1299, shippingCents: null, source: "CSV" });
  });
  it("rejects malformed CSV", () => {
    expect(() => parseCatalogCsv('asin,title\nB012345678,"Unclosed')).toThrow("unclosed");
    expect(() => parseCatalogCsv("title,title\nA,B")).toThrow("duplicate");
  });
});
