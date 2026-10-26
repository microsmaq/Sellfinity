import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/ai/jev", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/jev")>();
  return { ...original, screenProductPairWithJev: vi.fn().mockResolvedValue(null), evaluateJevDecision: vi.fn().mockResolvedValue(null) };
});
import { evaluateJevDecision, screenProductPairWithJev } from "@/lib/ai/jev";
import {
  assessProductMatch,
  assessProductMatchRules,
  isApprovedProductMatch,
} from "@/lib/arbitrage/product-match";

describe("arbitrage product identity", () => {
  let modelSequence = 0;
  beforeEach(() => { vi.stubEnv("OPENROUTER_MATCH_MODEL", `test-model-${modelSequence++}`); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.mocked(screenProductPairWithJev).mockResolvedValue(null);
    vi.mocked(evaluateJevDecision).mockReset().mockResolvedValue(null);
  });

  it("keeps strong Jev conflicts out of approval without a visual API call", async () => {
    vi.mocked(screenProductPairWithJev).mockResolvedValue({ sameProductProbability: 0.001, conflictProbability: 0.999, route: "REJECT", durationMs: 10 });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await assessProductMatch(
      { title: "Acme Cotton Black Knee Strap Support" },
      { title: "Acme Silicone Red Knee Strap Support" },
    );
    expect(result).toMatchObject({ verdict: "REJECTED", method: "DECISIONS" });
    expect(isApprovedProductMatch(result)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
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

  it("uses an image-aware decision fallback only after the visual provider runs out of credits", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }));
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(evaluateJevDecision).mockImplementation(async (_state, _questions, _diagnostic, _failure, _images, provider) => {
      provider?.("Jev fallback");
      return { sameVisualProduct: { type: "boolean", probability: 0.98 }, visualConflict: { type: "boolean", probability: 0.01 } };
    });
    const result = await assessProductMatch({ title: "Acme Black Lamp", imageUrl: "https://i.ebayimg.com/a.jpg" }, { title: "Acme Black Lamp", imageUrl: "https://m.media-amazon.com/a.jpg" });
    expect(result).toMatchObject({ method: "AI", verdict: "MATCH", confidence: 98, reason: expect.stringContaining("Jev fallback image verification") });
    expect(vi.mocked(evaluateJevDecision).mock.calls[0][4]).toEqual(["https://m.media-amazon.com/a.jpg", "https://i.ebayimg.com/a.jpg"]);
    vi.unstubAllEnvs();
  });

  it.each([401, 429, 500])("reports visual HTTP %s failures without overriding them through another provider", async (status) => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ error: { message: "Failure" } }, { status })));
    const report = vi.fn();
    const result = await assessProductMatch({ title: "Acme Lamp" }, { title: "Acme Lamp" }, report);
    expect(result.method).toBe("RULES");
    expect(evaluateJevDecision).not.toHaveBeenCalled();
    expect(report.mock.calls[0][0]).toContain(`HTTP ${status}`);
    vi.unstubAllEnvs();
  });

  it("keeps uncertain fallback image scores in review", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(null, { status: 402 })));
    vi.mocked(evaluateJevDecision).mockResolvedValue({ sameVisualProduct: { type: "boolean", probability: 0.94 }, visualConflict: { type: "boolean", probability: 0.02 } });
    expect(await assessProductMatch({ title: "Acme Lamp", imageUrl: "https://i.ebayimg.com/a" }, { title: "Acme Lamp", imageUrl: "https://m.media-amazon.com/a" })).toMatchObject({ verdict: "REVIEW", confidence: 94 });
    vi.unstubAllEnvs();
  });
  it("honors Retry-After without repeatedly calling a rate-limited visual provider", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ error: { message: "Provider returned error" } }, { status: 429, headers: { "retry-after": "120" } }));
    vi.stubGlobal("fetch", fetcher);
    const report = vi.fn();
    for (let i = 0; i < 3; i++) await assessProductMatch({ title: "Acme Lamp" }, { title: "Acme Lamp" }, report);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).toBe(120);
    expect(report.mock.calls[2][1]).toBeGreaterThan(115);
    expect(evaluateJevDecision).not.toHaveBeenCalled();
  });
});
