import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  vi.stubEnv("JEV_ENABLED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function response(same = 0.001, conflict = 0.999, route = "REJECT") {
  return Response.json({ answers: {
    sameProduct: { type: "boolean", probability: same },
    identityConflict: { type: "boolean", probability: conflict },
    route: { type: "choice", choice: route },
  } });
}

it("uses the decision endpoint and caches identical title pairs", async () => {
  const fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev, shouldSkipVisualVerification } = await import("@/lib/ai/jev");
  const result = await screenProductPairWithJev("Black strap", "Red strap");
  expect(result && shouldSkipVisualVerification(result)).toBe(true);
  await screenProductPairWithJev("Black strap", "Red strap");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.model).toBe("typesafe-ai/jev");
  expect(body.state.amazon.title).toBe("Black strap");
  expect(JSON.stringify(result)).not.toContain("test-key");
});

it("never skips visual verification for positive or uncertain screening", async () => {
  const { shouldSkipVisualVerification } = await import("@/lib/ai/jev");
  expect(shouldSkipVisualVerification({ sameProductProbability: 1, conflictProbability: 0, route: "VERIFY", durationMs: 1 })).toBe(false);
  expect(shouldSkipVisualVerification({ sameProductProbability: 0.1, conflictProbability: 0.9, route: "REJECT", durationMs: 1 })).toBe(false);
  expect(shouldSkipVisualVerification({ sameProductProbability: 0, conflictProbability: 1, route: "REVIEW", durationMs: 1 })).toBe(false);
});

it("falls back and cools down after an authentication failure", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B")).toBeNull();
  expect(await screenProductPairWithJev("C", "D")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects malformed probabilities and does not make requests without authentication", async () => {
  const fetcher = vi.fn().mockResolvedValue(response(2));
  vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  expect(await screenProductPairWithJev("A", "B")).toBeNull();
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  expect(await screenProductPairWithJev("C", "D", true)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses deployment identity when no separate Gateway key exists", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "test-identity");
  const fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetcher);
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  await screenProductPairWithJev("A", "B");
  expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer test-identity");
});

it("validates decision choices and missing answers before use", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ answers: { route: { type: "choice", choice: "PUBLISH" } } })));
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  expect(await evaluateJevDecision({}, { route: { type: "choice", instructions: "Route", criteria: { REVIEW: "Review manually" } } })).toBeNull();
});

it("batches named decisions and caches the full question/state combination", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ answers: { a: { type: "boolean", probability: 0.8 }, b: { type: "boolean", probability: 0.3 } } }));
  vi.stubGlobal("fetch", fetcher);
  const { evaluateJevDecision } = await import("@/lib/ai/jev");
  const questions = { a: { type: "boolean" as const, instructions: "A" }, b: { type: "boolean" as const, instructions: "B" } };
  expect(await evaluateJevDecision({ title: "Lamp" }, questions)).not.toBeNull();
  await evaluateJevDecision({ title: "Lamp" }, questions);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("reports provider diagnostics without exposing credentials", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Invalid request with test-key and Bearer sensitive-token" } }, { status: 400 })));
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  const report = vi.fn();
  expect(await screenProductPairWithJev("A", "B", true, report)).toBeNull();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("HTTP 400"));
  expect(report.mock.calls[0][0]).not.toContain("test-key");
  expect(report.mock.calls[0][0]).not.toContain("sensitive-token");
});

it("distinguishes unexpected response schemas from credential failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ answers: {} })));
  const { screenProductPairWithJev } = await import("@/lib/ai/jev");
  const report = vi.fn();
  await screenProductPairWithJev("A", "B", true, report);
  expect(report).toHaveBeenCalledWith(expect.stringContaining("unexpected response format"));
});
