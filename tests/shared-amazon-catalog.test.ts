import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  productFindFirst: vi.fn(),
  upsert: vi.fn(),
  scrape: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    adminArbitrageProduct: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
    product: { findFirst: mocks.productFindFirst },
  },
}));

vi.mock("@/lib/mirror/index", () => ({
  getScraper: () => ({ scrape: mocks.scrape }),
}));

import { getSharedAmazonProduct, sharedRowToScrapedProduct } from "@/lib/mirror/shared-catalog";
import { extractAsin } from "@/lib/mirror/scraper";

const sharedRow = {
  asin: "B012345678",
  amazonTitle: "Shared exact product",
  amazonPriceCents: 2_499,
  amazonShippingCents: 399,
  amazonUrl: "https://www.amazon.com/dp/B012345678",
  amazonImageUrl: "https://images.example/main.jpg",
  amazonBrand: "Exact Brand",
  amazonDescription: "Complete shared description",
  amazonBulletPointsJson: JSON.stringify(["Feature one", "Feature two"]),
  amazonImageUrlsJson: JSON.stringify([
    "https://images.example/main.jpg",
    "https://images.example/second.jpg",
  ]),
  amazonInStock: true,
  category: "Home",
};

describe("shared Amazon catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.productFindFirst.mockResolvedValue(null);
  });

  it("reuses an existing ASIN without calling the paid provider", async () => {
    mocks.findUnique.mockResolvedValue(sharedRow);

    const product = await getSharedAmazonProduct(
      "https://www.amazon.com/example/dp/B012345678",
    );

    expect(mocks.scrape).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(product).toMatchObject({
      sourceId: "B012345678",
      priceCents: 2_499,
      shippingCostCents: 399,
      bulletPoints: ["Feature one", "Feature two"],
      imageUrls: [
        "https://images.example/main.jpg",
        "https://images.example/second.jpg",
      ],
    });
  });

  it("calls the provider once for a new ASIN and saves the complete response", async () => {
    const scraped = {
      sourceId: "B087654321",
      sourceUrl: "https://www.amazon.com/dp/B087654321",
      title: "First-seen product",
      brand: "New Brand",
      bulletPoints: ["Accurate feature"],
      description: "Supplier description",
      category: "Tools",
      imageUrls: ["https://images.example/new.jpg"],
      priceCents: 3_199,
      shippingCostCents: 0,
      inStock: true,
    };
    mocks.findUnique.mockResolvedValue(null);
    mocks.scrape.mockResolvedValue(scraped);
    mocks.upsert.mockImplementation(async ({ create }) => ({ ...create }));

    const product = await getSharedAmazonProduct(
      "https://www.amazon.com/dp/B087654321",
    );

    expect(mocks.scrape).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { asin: "B087654321" },
      create: expect.objectContaining({
        asin: "B087654321",
        amazonDescription: "Supplier description",
        amazonBulletPointsJson: JSON.stringify(["Accurate feature"]),
        amazonImageUrlsJson: JSON.stringify(["https://images.example/new.jpg"]),
        status: "PENDING",
      }),
    }));
    expect(product?.title).toBe("First-seen product");
  });

  it("uses a provider-backed snapshot for a user fallback instead of promoting legacy seller data", async () => {
    const scraped = {
      sourceId: "B076543210",
      sourceUrl: "https://www.amazon.com/dp/B076543210",
      title: "Provider verified product",
      brand: "Verified Brand",
      bulletPoints: ["Current supplier fact"],
      description: "Current provider description",
      category: "Tools",
      imageUrls: ["https://images.example/provider.jpg"],
      priceCents: 4_299,
      shippingCostCents: 0,
      inStock: true,
    };
    mocks.findUnique.mockResolvedValue(null);
    mocks.productFindFirst.mockResolvedValue({
      sku: scraped.sourceId,
      supplierProductId: scraped.sourceId,
      costCents: 999,
      imageUrlsJson: JSON.stringify(["https://images.example/stale.jpg"]),
    });
    mocks.scrape.mockResolvedValue(scraped);
    mocks.upsert.mockImplementation(async ({ create }) => ({ ...create }));

    const product = await getSharedAmazonProduct(scraped.sourceId, {
      providerOnCatalogMiss: true,
    });

    expect(mocks.productFindFirst).not.toHaveBeenCalled();
    expect(mocks.scrape).toHaveBeenCalledTimes(1);
    expect(product?.priceCents).toBe(4_299);
  });

  it("enriches an older shared row once when its required image is missing", async () => {
    const incomplete = {
      ...sharedRow,
      amazonImageUrl: null,
      amazonImageUrlsJson: "[]",
      amazonDescription: "",
    };
    const enriched = {
      sourceId: incomplete.asin,
      sourceUrl: incomplete.amazonUrl,
      title: incomplete.amazonTitle,
      brand: "Recovered Brand",
      bulletPoints: ["Recovered product detail"],
      description: "Recovered description",
      category: incomplete.category,
      imageUrls: ["https://images.example/recovered.jpg"],
      priceCents: incomplete.amazonPriceCents,
      shippingCostCents: incomplete.amazonShippingCents,
      inStock: true,
    };
    mocks.findUnique.mockResolvedValue(incomplete);
    mocks.scrape.mockResolvedValue(enriched);
    mocks.upsert.mockImplementation(async ({ update }) => ({
      ...incomplete,
      ...update,
    }));

    const product = await getSharedAmazonProduct(incomplete.amazonUrl);

    expect(mocks.scrape).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { asin: incomplete.asin },
      update: expect.objectContaining({
        amazonImageUrl: "https://images.example/recovered.jpg",
        amazonDescription: "Recovered description",
      }),
    }));
    expect(product?.imageUrls).toEqual(["https://images.example/recovered.jpg"]);
  });

  it("promotes a legacy seller import without spending a provider credit", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.productFindFirst.mockResolvedValue({
      sku: "B099999999",
      supplierProductId: "B099999999",
      supplierUrl: "https://www.amazon.com/dp/B099999999",
      title: "Previously imported product",
      description: "Stored supplier facts",
      category: "Office",
      imageUrlsJson: JSON.stringify(["https://images.example/legacy.jpg"]),
      costCents: 1_899,
      shippingCostCents: 250,
      supplierStock: 12,
      createdAt: new Date(),
    });
    mocks.upsert.mockImplementation(async ({ create }) => ({ ...create }));

    const product = await getSharedAmazonProduct("B099999999");

    expect(mocks.scrape).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(product).toMatchObject({
      sourceId: "B099999999",
      priceCents: 1_899,
      shippingCostCents: 250,
    });
  });
  const sponsoredUrl = "https://www.amazon.com/sspa/click?ie=UTF8&url=%2FNONENDU-Interactive%2Fdp%2FB0DQJ6FXXL%2Fref%3Dsr_1_1_sspa%3Fpsc%3D1";
  it("recognizes the reported sponsored Amazon product link", () => {
    expect(extractAsin(sponsoredUrl)).toBe("B0DQJ6FXXL");
    expect(extractAsin("https://www.amazon.com/gp/aw/d/B0DQJ6FXXL")).toBe("B0DQJ6FXXL");
    expect(extractAsin("https://www.amazon.com/sspa/click?url=https%3A%2F%2Fevil.example%2Fdp%2FB0DQJ6FXXL")).toBeNull();
    expect(extractAsin("https://notamazon.com/sspa/click?url=%2Fdp%2FB0DQJ6FXXL")).toBeNull();
    expect(extractAsin("https://www.amazon.com/sspa/click?url=javascript%3Aalert(1)")).toBeNull();
    expect(extractAsin("https://www.amazon.com/sspa/click?url=%2Fsspa%2Fclick%3Furl%3D%252Fdp%252FB0DQJ6FXXL")).toBeNull();
  });
  it("repairs incomplete saved sponsored-link products using the known ASIN, not the ad redirect", async () => {
    const incomplete = { ...sharedRow, asin: "B0DQJ6FXXL", amazonUrl: sponsoredUrl, amazonImageUrl: null, amazonImageUrlsJson: "[]", amazonDescription: "" };
    const enriched = { sourceId: incomplete.asin, sourceUrl: sponsoredUrl, title: incomplete.amazonTitle, brand: "NONENDU", description: "Full product description", bulletPoints: ["Rechargeable"], category: "Pet Supplies", imageUrls: ["https://example.com/cat.jpg"], priceCents: 799, shippingCostCents: 0, inStock: true };
    mocks.findUnique.mockResolvedValue(incomplete);
    mocks.scrape.mockResolvedValue(enriched);
    mocks.upsert.mockImplementation(async ({ update }) => ({ ...incomplete, ...update }));
    const product = await getSharedAmazonProduct(sponsoredUrl, { providerOnCatalogMiss: true, requirePurchasable: true });
    expect(mocks.scrape).toHaveBeenCalledExactlyOnceWith("https://www.amazon.com/dp/B0DQJ6FXXL");
    expect(product).toMatchObject({ sourceId: incomplete.asin, sourceUrl: "https://www.amazon.com/dp/B0DQJ6FXXL", priceCents: 799, description: "Full product description" });
    expect(mocks.upsert.mock.calls[0][0].update.amazonUrl).toBe("https://www.amazon.com/dp/B0DQJ6FXXL");
  });
  it("reuses a complete saved sponsored-link product without any provider calls", async () => {
    mocks.findUnique.mockResolvedValue({ ...sharedRow, asin: "B0DQJ6FXXL", amazonUrl: sponsoredUrl });
    const product = await getSharedAmazonProduct(sponsoredUrl, { providerOnCatalogMiss: true, requirePurchasable: true });
    expect(mocks.scrape).not.toHaveBeenCalled();
    expect(product?.sourceUrl).toBe("https://www.amazon.com/dp/B0DQJ6FXXL");
    expect(sharedRowToScrapedProduct({ ...sharedRow, amazonUrl: "broken legacy link" }).sourceUrl).toBe(sharedRow.amazonUrl);
  });
  it("explains confirmed unavailability when publishing, but preserves null for sync", async () => {
    mocks.findUnique.mockResolvedValue({ ...sharedRow, amazonInStock: false });
    await expect(getSharedAmazonProduct(sharedRow.asin, { providerOnCatalogMiss: true, requirePurchasable: true })).rejects.toThrow("admin catalog marks this item unavailable");
    expect(await getSharedAmazonProduct(sharedRow.asin)).toBeNull();
    expect(mocks.scrape).not.toHaveBeenCalled();
  });
  it("explains incomplete content instead of blaming a valid product URL", async () => {
    mocks.findUnique.mockResolvedValue({ ...sharedRow, amazonImageUrl: null, amazonImageUrlsJson: "[]" });
    mocks.scrape.mockResolvedValue(null);
    await expect(getSharedAmazonProduct(sharedRow.asin, { providerOnCatalogMiss: true, requirePurchasable: true })).rejects.toThrow("saved product details are incomplete");
  });
  it("does not bypass unverified shipping or availability after identity-only admin approval", async () => {
    mocks.findUnique.mockResolvedValue({ ...sharedRow, amazonShippingVerified: false });
    await expect(getSharedAmazonProduct(sharedRow.asin, { requirePurchasable: true })).rejects.toThrow("manual verification");
    mocks.findUnique.mockResolvedValue({ ...sharedRow, amazonImportDetailsJson: '{"availability":"UNKNOWN"}' });
    await expect(getSharedAmazonProduct(sharedRow.asin, { requirePurchasable: true })).rejects.toThrow("manual verification");
    expect(mocks.scrape).not.toHaveBeenCalled();
  });
  it("never saves a provider result for a different ASIN under the requested source", async () => {
    mocks.findUnique.mockResolvedValue({ ...sharedRow, amazonImageUrl: null, amazonImageUrlsJson: "[]" });
    mocks.scrape.mockResolvedValue({ sourceId: "B099999999", imageUrls: ["https://example.com/wrong.jpg"] });
    await expect(getSharedAmazonProduct(sharedRow.asin, { requirePurchasable: true })).rejects.toThrow("different ASIN");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it.each([{ inStock: false, priceCents: 799, reason: "marks this item unavailable" }, { inStock: true, priceCents: 0, reason: "purchase price is missing" }])("keeps refreshed unusable source data blocked: %j", async ({ inStock, priceCents, reason }) => {
    const incomplete = { ...sharedRow, amazonImageUrl: null, amazonImageUrlsJson: "[]" };
    mocks.findUnique.mockResolvedValue(incomplete);
    mocks.scrape.mockResolvedValue({ sourceId: sharedRow.asin, sourceUrl: sharedRow.amazonUrl, title: sharedRow.amazonTitle, brand: "Brand", description: "Description", bulletPoints: [], category: "Home", imageUrls: ["https://example.com/new.jpg"], inStock, priceCents, shippingCostCents: 0 });
    mocks.upsert.mockImplementation(async ({ update }) => ({ ...incomplete, ...update }));
    await expect(getSharedAmazonProduct(sharedRow.asin, { providerOnCatalogMiss: true, requirePurchasable: true })).rejects.toThrow(reason);
  });
});
