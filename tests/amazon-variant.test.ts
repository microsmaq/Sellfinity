import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveExactAmazonVariant,
  selectExactAmazonVariant,
} from "@/lib/mirror/variant";

afterEach(() => vi.unstubAllGlobals());

const variants = [
  {
    asin: "BLUE-SMALL",
    title: "Blue / Small",
    dimensions: [
      { name: "Color", value: "Blue" },
      { name: "Size", value: "Small" },
    ],
  },
  {
    asin: "BLUE-LARGE",
    title: "Blue / Large",
    dimensions: [
      { name: "Color", value: "Blue" },
      { name: "Size", value: "Large" },
    ],
  },
  {
    asin: "RED-LARGE",
    title: "Red / Large",
    dimensions: [
      { name: "Color", value: "Red" },
      { name: "Size", value: "Large" },
    ],
  },
];

describe("exact Amazon variant selection", () => {
  it("selects the child matching every promoted dimension", () => {
    expect(selectExactAmazonVariant("Outdoor Jacket Blue Large", variants)?.asin).toBe(
      "BLUE-LARGE",
    );
  });

  it("fails closed when a varying dimension is missing", () => {
    expect(selectExactAmazonVariant("Outdoor Jacket Large", variants)).toBeNull();
  });

  it("does not use another color's price", () => {
    expect(selectExactAmazonVariant("Outdoor Jacket Red Large", variants)?.asin).toBe(
      "RED-LARGE",
    );
  });

  it("requires a unique variant title when dimensions are absent", () => {
    const packs = [
      { asin: "PACK-4", title: "4 Pack" },
      { asin: "PACK-8", title: "8 Pack" },
    ];
    expect(selectExactAmazonVariant("LED Lights 8 Pack", packs)?.asin).toBe("PACK-8");
    expect(selectExactAmazonVariant("LED Lights", packs)).toBeNull();
  });

  it("returns the selected child ASIN's own live price", async () => {
    const oldRainforest = process.env.RAINFOREST_API_KEY;
    const oldOpenRouter = process.env.OPENROUTER_API_KEY;
    const oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.RAINFOREST_API_KEY = "test-key";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            product: {
              asin: "BLUE-SMALL",
              title: "Outdoor Jacket Blue Small",
              title_excluding_variant_name: "Outdoor Jacket",
              variants: variants.map((variant, index) => ({
                ...variant,
                price: { value: [19.99, 34.99, 29.99][index] },
              })),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await resolveExactAmazonVariant(
      { title: "Outdoor Jacket Blue Large" },
      {
        asin: "BLUE-SMALL",
        title: "Outdoor Jacket",
        priceCents: 1999,
        url: "https://www.amazon.com/dp/BLUE-SMALL",
      },
    );

    if (oldRainforest === undefined) delete process.env.RAINFOREST_API_KEY;
    else process.env.RAINFOREST_API_KEY = oldRainforest;
    if (oldOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouter;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAi;
    expect(result).toMatchObject({ asin: "BLUE-LARGE", priceCents: 3499 });
  });
});
