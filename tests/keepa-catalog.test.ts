import { describe, expect, it } from "vitest";
import { availableKeepaTokens, automaticKeepaCategories, bestsellerAsins, keepaCatalogData, keepaDate, rootCategories } from "@/lib/keepa/catalog";

const source = { asin: "B012345678", categoryId: "123", categoryName: "Home", bestsellerRank: 7, fetchedAt: new Date("2026-10-20T12:00:00Z") };
const product = { asin: source.asin, domainId: 1, productType: 0, title: "Sample product", brand: "Acme", description: "Product description", features: ["Feature one"], images: [{ l: "81bRlmLRyPL.jpg", lW: 1500, lH: 1500 }], lastUpdate: 8300000, stats: { current: [1299, 1599] }, model: "AB1", color: "Blue", size: "Large", categoryTree: [{ name: "Kitchen" }] };

describe("Keepa catalog decoding", () => {
  it("maps content and price without inventing shipping or marketplace stock", () => {
    const row = keepaCatalogData(product, source)!;
    expect(row).toMatchObject({ asin: source.asin, amazonTitle: product.title, amazonBrand: "Acme", amazonPriceCents: 1299, amazonShippingVerified: false, amazonInStock: false, amazonShippingCents: 0, category: "Kitchen", status: "PENDING", matchVerdict: "UNVERIFIED", amazonDescription: product.description });
    expect(JSON.parse(row.amazonBulletPointsJson)).toEqual(product.features);
    expect(JSON.parse(row.amazonImageUrlsJson)).toEqual(["https://m.media-amazon.com/images/I/81bRlmLRyPL.jpg"]);
    expect(JSON.parse(row.amazonImportDetailsJson)).toMatchObject({ source: "KEEPA", bestsellerRank: 7, availability: "UNKNOWN", shippingCents: null, variant: "AB1 · Blue · Large", missingDetails: ["Verified shipping and availability"] });
    expect(row.amazonRefreshedAt).toEqual(keepaDate(product.lastUpdate));
  });
  it("keeps missing data unknown and flags it for repair", () => {
    const row = keepaCatalogData({ asin: source.asin, domainId: 1, productType: 0, title: "Unknown-cost product", availabilityAmazon: -1 }, source)!;
    expect(row.amazonRefreshedAt).toBeNull(); expect(row.amazonPriceCents).toBe(0);
    expect(JSON.parse(row.amazonImportDetailsJson).missingDetails).toEqual(["Description", "Features", "Images", "Current price", "Verified shipping and availability"]);
    expect(row.amazonInStock).toBe(false);
  });
  it.each([1, 2, 3, 4, 5])("holds nonstandard product type %i", (productType) => expect(keepaCatalogData({ ...product, productType }, source)).toBeNull());
  it.each([{ asin: "B099999999" }, { domainId: 2 }, { title: "" }])("rejects wrong identity/locale or missing title: %j", (patch) => expect(keepaCatalogData({ ...product, ...patch }, source)).toBeNull());
  it("supports legacy images but rejects arbitrary URLs, paths and HTML", () => {
    const row = keepaCatalogData({ ...product, images: undefined, imagesCSV: "a.jpg,a.jpg,../../evil.jpg,https://evil.example/x.jpg,<script>.jpg,b.png" }, source)!;
    expect(JSON.parse(row.amazonImageUrlsJson)).toEqual(["https://m.media-amazon.com/images/I/a.jpg", "https://m.media-amazon.com/images/I/b.png"]);
  });
  it("does not use missing or negative sentinel prices", () => {
    expect(keepaCatalogData({ ...product, stats: { current: [-1, 555] } }, source)?.amazonPriceCents).toBe(555);
    expect(keepaCatalogData({ ...product, stats: { current: [-2, -1] } }, source)?.amazonPriceCents).toBe(0);
  });
  it("reads complete bestseller arrays beyond the first 1000", () => {
    const asins = Array.from({ length: 1005 }, (_, i) => `B${String(i).padStart(9, "0")}`);
    expect(bestsellerAsins({ bestSellersList: { asinList: [...asins, "invalid"] } })).toEqual(asins);
  });
  it("reads root category lookup responses and sorts by name", () => {
    expect(rootCategories({ categories: { 2: { catId: 2, name: "Tools" }, 1: { catId: 1, name: "Home" }, invalid: {} } })).toEqual([{ id: "1", name: "Home" }, { id: "2", name: "Tools" }]);
    expect(rootCategories({ categories: [{ catId: "1", name: "Home" }] })).toEqual([{ id: "1", name: "Home" }]);
  });
  it("uses physical-product roots for automatic startup, not digital downloads", () => {
    expect(automaticKeepaCategories([{ id: "1", name: "Home & Kitchen" }, { id: "2", name: "Kindle Store" }, { id: "3", name: "Apps & Games" }, { id: "4", name: "Books" }])).toEqual([{ id: "1", name: "Home & Kitchen" }, { id: "4", name: "Books" }]);
  });
  it("does not treat invalid Keepa dates as a fresh price check", () => { expect(keepaDate(-1)).toBeNull(); expect(keepaDate(undefined)).toBeNull(); });
});

describe("conservative 20-token-per-minute scheduling", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("treats an unobserved balance as unknown", () => expect(availableKeepaTokens({ tokensLeft: null, tokenSampleAt: null, refillRate: 20 }, now)).toBeNull());
  it("adds whole-minute refills only and caps a full hour", () => {
    expect(availableKeepaTokens({ tokensLeft: 3, tokenSampleAt: new Date(now.getTime() - 119999), refillRate: 20 }, now)).toBe(23);
    expect(availableKeepaTokens({ tokensLeft: 3, tokenSampleAt: new Date(now.getTime() - 7200000), refillRate: 20 }, now)).toBe(1200);
  });
  it("respects slower provider refill and never assumes a faster subscription", () => {
    const tokenSampleAt = new Date(now.getTime() - 60000);
    expect(availableKeepaTokens({ tokensLeft: 0, tokenSampleAt, refillRate: 5 }, now)).toBe(5);
    expect(availableKeepaTokens({ tokensLeft: 0, tokenSampleAt, refillRate: 100 }, now)).toBe(20);
    expect(availableKeepaTokens({ tokensLeft: 0, tokenSampleAt, refillRate: 0 }, now)).toBe(0);
  });
  it("repays a negative provider balance before allocating new refill tokens", () => {
    expect(availableKeepaTokens({ tokensLeft: -3, tokenSampleAt: now, refillRate: 20 }, now)).toBe(0);
    expect(availableKeepaTokens({ tokensLeft: -3, tokenSampleAt: new Date(now.getTime() - 60000), refillRate: 20 }, now)).toBe(17);
  });
});
