import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/jev", () => ({ evaluateJevDecision: vi.fn().mockResolvedValue(null) }));
import { improveListingContent } from "@/lib/mirror/improve-listing-content";
import { evaluateJevDecision } from "@/lib/ai/jev";

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(evaluateJevDecision).mockResolvedValue(null);
  process.env.OPENAI_API_KEY = originalOpenAiKey;
  process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
});

describe("improveListingContent", () => {
  it("does not return generated copy that Jev flags as conflicting", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OPENROUTER_API_KEY;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ output_text: JSON.stringify({ title: "Lamp 10 pack", bulletPoints: ["Ten lamps"], description: "Ten lamps included" }) }));
    vi.mocked(evaluateJevDecision).mockResolvedValue({ identityConflict: { type: "boolean", probability: 0.999 }, unsupportedClaims: { type: "boolean", probability: 0 } });
    const result = await improveListingContent({ title: "Lamp 2 pack", brand: "Acme", category: "Lamps", bulletPoints: ["Two lamps"], description: "Two lamps included" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/original supplier copy was preserved/);
  });
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
