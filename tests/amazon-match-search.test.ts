import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findAmazonCatalogProducts,
  findAmazonMatches,
} from "@/lib/mirror/match";
import { resolveExactAmazonVariant } from "@/lib/mirror/variant";

const originalKey = process.env.RAINFOREST_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.RAINFOREST_API_KEY;
  else process.env.RAINFOREST_API_KEY = originalKey;
});

describe("Amazon replacement-source search safety", () => {
  it("turns one source-first search page into multiple unique Amazon products", async () => {
    process.env.RAINFOREST_API_KEY = "test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          request_info: { success: true },
          search_results: [
            { asin: "B000000001", title: "Coffee Grinder", price: { value: 19.99 } },
            { asin: "B000000002", title: "Coffee Scale", price: { value: 14.5 } },
            { asin: "B000000001", title: "Duplicate", price: { value: 19.99 } },
            { asin: "B000000003", title: "Unavailable" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const products = await findAmazonCatalogProducts("coffee accessories", 2);
    expect(products.map((product) => product.asin)).toEqual([
      "B000000001",
      "B000000002",
    ]);
    expect(products[0].priceCents).toBe(1999);
    expect(String(fetchMock.mock.calls[0][0])).toContain("page=2");
  });

  it("coalesces concurrent identical searches into one provider request", async () => {
    process.env.RAINFOREST_API_KEY = "test";
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({ request_info: { success: true }, search_results: [] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      findAmazonCatalogProducts("wireless charger", 1),
      findAmazonCatalogProducts("wireless charger", 1),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can restrict discovery to Amazon bestseller-ranked organic results", async () => {
    process.env.RAINFOREST_API_KEY = "test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ request_info: { success: true }, search_results: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await findAmazonCatalogProducts(
      "garden tools",
      1,
      "arbitrage_catalog_search",
      { bestSellersOnly: true },
    );

    const requestUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestUrl).toContain("sort_by=bestseller_rankings");
    expect(requestUrl).toContain("exclude_sponsored=true");
  });

  it("throws on an incomplete provider response instead of treating it as no match", async () => {
    process.env.RAINFOREST_API_KEY = "test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ request_info: { success: false } }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      findAmazonMatches("specific replacement product", 5, {
        throwOnError: true,
      }),
    ).rejects.toThrow("Amazon source search failed");
  });

  it("allows a successful search with no candidates to return an empty result", async () => {
    process.env.RAINFOREST_API_KEY = "test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            request_info: { success: true },
            search_results: [],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      findAmazonMatches("specific replacement product", 5, {
        throwOnError: true,
      }),
    ).resolves.toEqual([]);
  });

  it("does not treat a failed live variant lookup as proof that the source is gone", async () => {
    process.env.RAINFOREST_API_KEY = "test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ request_info: { success: false } }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      resolveExactAmazonVariant(
        { title: "Specific replacement product" },
        {
          asin: "B000TEST01",
          title: "Specific replacement product",
          priceCents: 2000,
          url: "https://www.amazon.com/dp/B000TEST01",
        },
      ),
    ).rejects.toThrow("incomplete response");
  });
});
