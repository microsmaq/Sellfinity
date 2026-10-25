import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
beforeEach(() => { vi.resetModules(); vi.stubEnv("OPENAI_API_KEY", "test-key"); vi.stubEnv("OPENAI_DECISIONS_ENABLED", "true"); vi.stubEnv("OPENAI_DECISIONS_MODEL", "gpt-6-luna"); vi.stubEnv("AI_GATEWAY_API_KEY", ""); vi.stubEnv("VERCEL_OIDC_TOKEN", ""); vi.stubEnv("JEV_ENABLED", "true"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function response(same = 0.001, conflict = 0.999, route = "REJECT") {
  return Response.json({ answers: [
    { name: "sameProduct", type: "predicate", probability: same },
    { name: "identityConflict", type: "predicate", probability: conflict },
    { name: "route", type: "choice", choice: route, confidence: 0.99, probabilities: [{ value: route, probability: 0.99 }] },
  ] });
}
it("uses OpenAI Decisions and caches identical questions and input", async () => {
  const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev, shouldSkipVisualVerification } = await import("@/lib/ai/jev");
  const result = await screenProductPairWithJev("Black strap", "Red strap");
  expect(result && shouldSkipVisualVerification(result)).toBe(true);
  await screenProductPairWithJev("Black strap", "Red strap");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/decisions");
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.model).toBe("gpt-6-luna");
  expect(JSON.parse(body.input).amazon.title).toBe("Black strap");
  expect(body.questions[0]).toMatchObject({ name: "sameProduct", type: "predicate" });
  expect(body.questions[2].choices).toContainEqual({ value: "REJECT", description: expect.any(String) });
  expect(JSON.stringify(result)).not.toContain("test-key");
});
it("never skips visual verification for positive or uncertain decisions", async () => {
  const { shouldSkipVisualVerification } = await import("@/lib/ai/jev");
  expect(shouldSkipVisualVerification({ sameProductProbability: 1, conflictProbability: 0, route: "VERIFY", durationMs: 1 })).toBe(false);
  expect(shouldSkipVisualVerification({ sameProductProbability: 0.1, conflictProbability: 0.9, route: "REJECT", durationMs: 1 })).toBe(false);
});
it("sends two labeled product images as Decisions image parts, not just image URL text", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ answers: [{ name: "same", type: "predicate", probability: 0.96 }] })); vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const questions = { same: { type: "boolean" as const, instructions: "Compare identity" } };
  const images = ["https://example.com/amazon.jpg", "https://example.com/ebay.jpg"];
  const state = { imageOrder: ["Amazon source", "eBay comparison"] };
  await evaluateJevDecision(state, questions, false, undefined, images);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.input).toEqual([{ role: "user", content: [
    { type: "input_text", text: JSON.stringify(state) },
    ...images.map((image_url) => ({ type: "input_image", image_url, detail: "high" })),
  ] }]);
  await evaluateJevDecision(state, questions, false, undefined, images);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await evaluateJevDecision(state, questions, false, undefined, [images[0], "https://example.com/different.jpg"]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("does not call Decisions with invalid or excessive image inputs", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const questions = { same: { type: "boolean" as const, instructions: "Compare identity" } };
  for (const images of [["file:///private.jpg"], ["not a URL"], Array(3).fill("https://example.com/a.jpg")]) {
    expect(await evaluateJevDecision({}, questions, false, undefined, images)).toBeNull();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("falls back and cools down after authentication failure", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 })); vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B")).toBeNull();
  expect(await screenProductPairWithJev("C", "D")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects out-of-range probabilities", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(2)));
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B")).toBeNull();
});
it("does not send Vercel credentials to OpenAI or call without an OpenAI key", async () => {
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("AI_GATEWAY_API_KEY", "gateway"); vi.stubEnv("VERCEL_OIDC_TOKEN", "identity");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev, jevConfiguration } = await import("@/lib/ai/jev");
  expect(jevConfiguration().configured).toBe(false);
  expect(await screenProductPairWithJev("A", "B", true)).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [{ name: "a", type: "refusal" }],
  [{ name: "wrong", type: "predicate", probability: 0.9 }],
  [],
  [{ name: "a", type: "predicate", probability: 0.9 }, { name: "a", type: "predicate", probability: 0.8 }],
])("rejects refused, missing, duplicate or wrongly named answers: %j", async (...answers) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ answers })));
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  expect(await evaluateJevDecision({}, { a: { type: "boolean", instructions: "A" } })).toBeNull();
});
it("rejects choices not supplied in the question", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ answers: [{ name: "route", type: "choice", choice: "PUBLISH", confidence: 1, probabilities: [] }] })));
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  expect(await evaluateJevDecision({}, { route: { type: "choice", instructions: "Route", criteria: { REVIEW: "Review" } } })).toBeNull();
});
it("reports provider errors with secrets redacted", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Invalid test-key and Bearer sensitive-token" } }, { status: 400 })));
  const { screenProductPairWithJev } = await import("@/lib/ai/jev"); const report = vi.fn();
  expect(await screenProductPairWithJev("A", "B", true, report)).toBeNull();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("HTTP 400"));
  expect(report.mock.calls[0][0]).not.toContain("test-key"); expect(report.mock.calls[0][0]).not.toContain("sensitive-token");
});

it("uses Jev on exhausted credits, preserving image inputs and caching its own answers", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "credit_balance_exhausted", message: "You have no credits remaining" } }, { status: 429 }))
    .mockImplementation(async () => Response.json({ answers: [{ name: "same", type: "predicate", probability: 0.98 }] }));
  vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const questions = { same: { type: "boolean" as const, instructions: "Compare exact identity" } };
  const images = ["https://example.com/amazon.jpg", "https://example.com/ebay.jpg"];
  const provider = vi.fn();
  expect(await evaluateJevDecision({ title: "A" }, questions, false, undefined, images, provider)).toMatchObject({ same: { probability: 0.98 } });
  expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer test-key");
  expect(fetcher.mock.calls[1][0]).toBe("https://ai-gateway.vercel.sh/v1/decisions");
  expect(fetcher.mock.calls[1][1].headers.authorization).toBe("Bearer gateway-key");
  const openai = JSON.parse(fetcher.mock.calls[0][1].body);
  const jev = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(jev).toEqual({ ...openai, model: "typesafe-ai/jev-1.14.0" });
  expect(provider).toHaveBeenLastCalledWith("Jev fallback");
  await evaluateJevDecision({ title: "A" }, questions, false, undefined, images);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await evaluateJevDecision({ title: "B" }, questions);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://api.openai.com/v1/decisions", "https://ai-gateway.vercel.sh/v1/decisions", "https://ai-gateway.vercel.sh/v1/decisions"]);
});

it.each([401, 403, 400, 429, 500])("does not switch providers for unrelated HTTP %s failures", async (status) => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "rate_limit_exceeded" } }, { status })); vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not use fallback to override an uncertain or rejected answer", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");
  const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B")).toMatchObject({ route: "REJECT", provider: "OpenAI Decisions" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["disabled", "missing", "invalid", "failed"])("holds approval if Jev fallback is %s", async (mode) => {
  if (mode !== "missing") vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");
  if (mode === "disabled") vi.stubEnv("JEV_ENABLED", "false");
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }))
    .mockImplementation(async () => mode === "failed" ? new Response(null, { status: 503 }) : Response.json({ answers: [{ name: "same", type: "predicate", probability: 4 }] }));
  vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  expect(await evaluateJevDecision({}, { same: { type: "boolean", instructions: "Same?" } })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(["missing", "disabled"].includes(mode) ? 1 : 2);
});

it("reports successful fallback diagnostics and permits a later primary retry", async () => {
  vi.stubEnv("VERCEL_OIDC_TOKEN", "identity-key");
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "You have no credits remaining" } }, { status: 429 }))
    .mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B", true)).toMatchObject({ provider: "Jev fallback" });
  expect(fetcher.mock.calls[1][1].headers.authorization).toBe("Bearer identity-key");
  expect(await screenProductPairWithJev("A", "B", true)).toMatchObject({ provider: "OpenAI Decisions" });
  expect(fetcher.mock.calls[2][0]).toBe("https://api.openai.com/v1/decisions");
});

it("reports the actual Jev failure in normal approval calls with secrets removed", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-secret");
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "credit_balance_exhausted" } }, { status: 429 }))
    .mockResolvedValueOnce(Response.json({ error: { message: "Image input rejected for gateway-secret Bearer hidden at https://private.test" } }, { status: 400 }));
  vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const report = vi.fn();
  expect(await evaluateJevDecision({}, { same: { type: "boolean", instructions: "Same?" } }, false, report, ["https://example.com/a.jpg"])).toBeNull();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("Jev fallback returned HTTP 400"));
  expect(report.mock.calls[0][0]).not.toMatch(/gateway-secret|Bearer hidden|private\.test/);
});

it("does not keep extending Jev cooldown as more products are checked", async () => {
  const started = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(started);
  try {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "credit_balance_exhausted" } }, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => Response.json({ answers: [{ name: "same", type: "predicate", probability: 0.98 }] }));
    vi.stubGlobal("fetch", fetcher);
    const { evaluateJevDecision } = await import("@/lib/ai/jev");
    const questions = { same: { type: "boolean" as const, instructions: "Same?" } };
    const report = vi.fn();
    expect(await evaluateJevDecision({ item: 0 }, questions)).toBeNull();
    for (const seconds of [20, 40, 59]) {
      now.mockReturnValue(started + seconds * 1000);
      expect(await evaluateJevDecision({ item: seconds }, questions, false, report)).toBeNull();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("Retry in 1 seconds"));
    now.mockReturnValue(started + 60_001);
    expect(await evaluateJevDecision({ item: 60 }, questions)).toMatchObject({ same: { probability: 0.98 } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).model).toBe("typesafe-ai/jev");
  } finally { now.mockRestore(); }
});

it("reports invalid image inputs without contacting either provider", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const report = vi.fn();
  expect(await evaluateJevDecision({}, { same: { type: "boolean", instructions: "Same?" } }, false, report, [""])).toBeNull();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("valid HTTPS image URL"));
  expect(fetcher).not.toHaveBeenCalled();
});
