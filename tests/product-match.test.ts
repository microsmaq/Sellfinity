import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessProductMatch,
  assessProductMatchRules,
  isApprovedProductMatch,
} from "@/lib/arbitrage/product-match";

describe("arbitrage product identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("approves the same product with reordered marketplace wording", () => {
    const result = assessProductMatchRules(
      "CIRCLE JOY Handheld Milk Frother Electric Whisk USB Rechargeable 3 Speed",
      "CIRCLE JOY Rechargeable Milk Frother Handheld Electric Whisk, 3 Speeds",
    );
    expect(result.verdict).toBe("LIKELY");
    expect(isApprovedProductMatch(result)).toBe(true);
  });

  it("rejects unrelated products despite a generic shared word", () => {
    const result = assessProductMatchRules(
      "Wireless Bluetooth Speaker Portable Waterproof Outdoor",
      "Wireless Charger Stand Fast Charging for iPhone",
    );
    expect(result.verdict).toBe("REJECTED");
    expect(isApprovedProductMatch(result)).toBe(false);
  });

  it("rejects conflicting models, quantities, and sizes", () => {
    expect(
      assessProductMatchRules("Sony WH1000XM5 Headphones", "Sony WH1000XM4 Headphones").reason,
    ).toMatch(/model/i);
    expect(
      assessProductMatchRules("Dog Treats 12 Pack Chicken", "Dog Treats 6 Pack Chicken").reason,
    ).toMatch(/quantit/i);
    expect(
      assessProductMatchRules("Ceramic Lamp 27 inch Blue", "Ceramic Lamp 18 inch Blue").reason,
    ).toMatch(/size|capacity/i);
  });

  it("fails safely to rules when no AI key is configured", async () => {
    const previousOpenRouter = process.env.OPENROUTER_API_KEY;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = await assessProductMatch(
      { title: "Adjustable Dumbbell Set 25lb Pair with Rack" },
      { title: "25lb Adjustable Dumbbell Pair and Storage Rack" },
    );
    process.env.OPENROUTER_API_KEY = previousOpenRouter;
    process.env.OPENAI_API_KEY = previousOpenAi;
    expect(result.method).toBe("RULES");
    expect(result.verdict).not.toBe("REJECTED");
  });

  it("uses an OpenRouter chat completion when configured", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"verdict":"MATCH","confidence":96,"reason":"Same model and variant."}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await assessProductMatch(
      { title: "Sony WH1000XM5 Wireless Headphones" },
      { title: "Sony WH1000XM5 Bluetooth Wireless Headphones" },
    );
    process.env.OPENROUTER_API_KEY = previous;

    expect(result).toMatchObject({ verdict: "MATCH", confidence: 96, method: "AI" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer test-openrouter-key",
      "X-OpenRouter-Title": "Sellfinity",
    });
  });
});
