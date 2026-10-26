import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("sends real encoded photos through the exhausted-credit fallback, not external URLs", async () => {
  vi.resetModules();
  vi.stubEnv("OPENAI_API_KEY", "primary-key"); vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");
  vi.stubEnv("OPENAI_DECISIONS_ENABLED", "true"); vi.stubEnv("JEV_ENABLED", "true");
  const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "https://api.openai.com/v1/decisions") return Response.json({ error: { code: "credit_balance_exhausted" } }, { status: 429 });
    if (url.startsWith("https://m.media-amazon.com/") || url.startsWith("https://i.ebayimg.com/")) {
      expect(options?.headers).toBeUndefined(); // No provider credentials sent to image hosts.
      return new Response(Uint8Array.from(photo), { headers: { "content-type": "image/png" } });
    }
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/decisions");
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("typesafe-ai/jev-1.14.0");
    const parts = body.input[0].content;
    expect(parts[0].text).toContain("Amazon source");
    expect(parts).toHaveLength(3);
    for (const part of parts.slice(1)) {
      expect(part.image_url).toMatch(/^data:image\/jpeg;base64,/);
      expect(await sharp(Buffer.from(part.image_url.split(",")[1], "base64")).metadata()).toMatchObject({ format: "jpeg", width: 32, height: 32 });
    }
    return Response.json({ answers: [{ name: "same", type: "predicate", probability: 0.98 }, { name: "conflict", type: "predicate", probability: 0.01 }] });
  });
  vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const questions = { same: { type: "boolean" as const, instructions: "Same product?" }, conflict: { type: "boolean" as const, instructions: "Identity conflict?" } };
  const state = { imageOrder: ["Amazon source", "eBay comparison"] };
  const images = ["https://m.media-amazon.com/source.png", "https://i.ebayimg.com/comparison.png"];
  const failure = vi.fn();
  expect(await evaluateJevDecision(state, questions, false, failure, images)).toEqual({ same: { type: "boolean", probability: 0.98 }, conflict: { type: "boolean", probability: 0.01 } });
  expect(failure).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(4);
  await evaluateJevDecision(state, questions, false, failure, images);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
