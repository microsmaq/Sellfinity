import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
beforeEach(() => { vi.resetModules(); vi.stubEnv("OPENAI_API_KEY", "test-key"); vi.stubEnv("OPENAI_DECISIONS_ENABLED", "true"); vi.stubEnv("OPENAI_DECISIONS_MODEL", "gpt-6-luna"); });
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
