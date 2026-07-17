import { afterEach, describe, expect, it, vi } from "vitest";
import { improveListingContent } from "@/lib/mirror/improve-listing-content";

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  process.env.OPENAI_API_KEY = originalOpenAiKey;
  process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
});

describe("improveListingContent", () => {
  it("returns bounded factual JSON copy from the Responses API", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OPENROUTER_API_KEY;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            title: "Compact Ceramic Bedside Lamp Set of 2",
            bulletPoints: ["Set of two lamps", "Ceramic bases", "Linen shades"],
            description: "A coordinated pair of ceramic bedside lamps.",
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await improveListingContent({
      title: "Supplier lamp title",
      brand: "Test Brand",
      category: "Lamps",
      bulletPoints: ["Set of two", "Ceramic base", "Linen shade"],
      description: "Two ceramic lamps with linen shades.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.title.length).toBeLessThanOrEqual(80);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails safely when no text provider is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await expect(
      improveListingContent({
        title: "Product",
        brand: "",
        category: "Other",
        bulletPoints: [],
        description: "Source copy",
      }),
    ).resolves.toEqual({ ok: false, error: "No AI text provider is configured." });
  });
});
