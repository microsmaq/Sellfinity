import { describe, expect, it } from "vitest";
import { mapRainforestProduct } from "@/lib/mirror/rainforest";
import { estimatedSales30d } from "@/lib/arbitrage/real-scanner";
import { titleSimilarity, titleTokens } from "@/lib/mirror/match";

describe("mapRainforestProduct", () => {
  const fixture = {
    title: "CIRCLE JOY Rechargeable Milk Frother Handheld, Dual Coil Whisk",
    brand: "CIRCLE JOY",
    feature_bullets: ["Dual coil whisk", "USB-C rechargeable", "3 speeds"],
    main_image: { link: "https://m.media-amazon.com/images/I/main.jpg" },
    images: [
      { link: "https://m.media-amazon.com/images/I/main.jpg" },
      { link: "https://m.media-amazon.com/images/I/alt1.jpg" },
    ],
    categories: [{ name: "Home & Kitchen" }, { name: "Milk Frothers" }],
    buybox_winner: {
      price: { value: 8.99 },
      availability: { type: "in_stock" },
    },
  };

  it("maps a complete product", () => {
    const p = mapRainforestProduct("B0DPG6SNV1", fixture)!;
    expect(p.sourceId).toBe("B0DPG6SNV1");
    expect(p.priceCents).toBe(899);
    expect(p.inStock).toBe(true);
    expect(p.brand).toBe("CIRCLE JOY");
    expect(p.category).toBe("Home & Kitchen");
    // deduped images, main first
    expect(p.imageUrls).toEqual([
      "https://m.media-amazon.com/images/I/main.jpg",
      "https://m.media-amazon.com/images/I/alt1.jpg",
    ]);
    expect(p.bulletPoints).toHaveLength(3);
    expect(p.description).toContain("Dual coil whisk");
  });

  it("rejects products without a title or buyable price", () => {
    expect(mapRainforestProduct("B0X", { ...fixture, title: undefined })).toBeNull();
    expect(
      mapRainforestProduct("B0X", { ...fixture, buybox_winner: {} }),
    ).toBeNull();
  });

  it("marks out-of-stock products", () => {
    const p = mapRainforestProduct("B0X", {
      ...fixture,
      buybox_winner: {
        price: { value: 8.99 },
        availability: { type: "out_of_stock" },
      },
    })!;
    expect(p.inStock).toBe(false);
  });
});

describe("title matching", () => {
  it("tokenizes without stopwords and noise", () => {
    expect(titleTokens("NEW Milk Frother, Handheld - Free Shipping!")).toEqual([
      "milk",
      "frother",
      "handheld",
    ]);
  });

  it("scores near-identical titles high and unrelated titles low", () => {
    const ebay = "Handheld Milk Frother Electric Whisk Coffee Mixer USB Rechargeable";
    const amazonGood = "CIRCLE JOY Rechargeable Milk Frother Handheld Electric Whisk for Coffee";
    const amazonBad = "Garden Hose Expandable 50ft with Spray Nozzle";
    expect(titleSimilarity(ebay, amazonGood)).toBeGreaterThan(0.5);
    expect(titleSimilarity(ebay, amazonBad)).toBeLessThan(0.15);
  });

  it("handles empty titles", () => {
    expect(titleSimilarity("", "anything")).toBe(0);
  });
});

describe("estimatedSales30d", () => {
  it("is deterministic and within a sane band", () => {
    const a = estimatedSales30d("v1|123|0", 1299);
    expect(a).toBe(estimatedSales30d("v1|123|0", 1299));
    expect(a).toBeGreaterThanOrEqual(5);
    expect(a).toBeLessThanOrEqual(65);
  });
});
