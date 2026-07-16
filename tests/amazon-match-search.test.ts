import { afterEach, describe, expect, it, vi } from "vitest";
import { findAmazonMatches } from "@/lib/mirror/match";
import { resolveExactAmazonVariant } from "@/lib/mirror/variant";

const originalKey = process.env.RAINFOREST_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.RAINFOREST_API_KEY;
  else process.env.RAINFOREST_API_KEY = originalKey;
});

describe("Amazon replacement-source search safety", () => {
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
