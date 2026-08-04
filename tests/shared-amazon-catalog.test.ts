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

import { getSharedAmazonProduct } from "@/lib/mirror/shared-catalog";

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
});
