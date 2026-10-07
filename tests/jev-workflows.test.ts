import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/jev", () => ({ evaluateJevDecision: vi.fn().mockResolvedValue(null) }));
import { evaluateJevDecision } from "@/lib/ai/jev";
import { prioritizeCatalogReview, classifySmartSyncError, checkGeneratedListingCopy } from "@/lib/ai/jev-workflows";
const evaluate = vi.mocked(evaluateJevDecision);
afterEach(() => { evaluate.mockReset(); evaluate.mockResolvedValue(null); });

describe("Jev advisory workflows", () => {
  it("prioritizes a bounded queue without adding, approving or removing items", async () => {
    const a = { amazonTitle: "Generic lamp", id: "a" };
    const b = { amazonTitle: "Acme ABC123 lamp", ebayTitle: "Acme ABC123 lamp", id: "b" };
    evaluate.mockResolvedValue({ item0: { type: "boolean", probability: 0.1 }, item1: { type: "boolean", probability: 0.9 } });
    expect(await prioritizeCatalogReview([a, b])).toEqual([b, a]);
    expect(a).toEqual({ amazonTitle: "Generic lamp", id: "a" });
  });
  it("keeps oldest-first ordering on service failure and ties", async () => {
    const items = [{ amazonTitle: "A" }, { amazonTitle: "B" }];
    expect(await prioritizeCatalogReview(items)).toBe(items);
    evaluate.mockResolvedValue({ item0: { type: "boolean", probability: 0.5 }, item1: { type: "boolean", probability: 0.5 } });
    expect(await prioritizeCatalogReview(items)).toEqual(items);
  });
  it("uses rules for familiar errors without spending Gateway credits", async () => {
    expect(await classifySmartSyncError("eBay (429): Too many requests")).toMatchObject({ category: "WAIT", method: "RULES" });
    expect(await classifySmartSyncError("403 Access denied")).toMatchObject({ category: "CONNECTION" });
    expect(await classifySmartSyncError("Administrator Amazon data is missing")).toMatchObject({ category: "SOURCE" });
    expect(await classifySmartSyncError("UPC field missing")).toMatchObject({ category: "CONTENT" });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("sanitizes unknown errors and returns advice, not an action", async () => {
    evaluate.mockResolvedValue({ route: { type: "choice", choice: "REVIEW" } });
    const result = await classifySmartSyncError("Unexpected response for buyer@example.com at https://example.com/private/123456789");
    expect(result).toMatchObject({ category: "REVIEW", method: "DECISIONS" });
    const state = JSON.stringify(evaluate.mock.calls[0][0]);
    expect(state).not.toContain("buyer@example.com");
    expect(state).not.toContain("example.com/private");
  });
  it("falls back to manual error review if Jev is unavailable", async () => {
    expect(await classifySmartSyncError("Unexpected response")).toMatchObject({ category: "REVIEW", method: "RULES" });
  });
  const source = { title: "Acme ABC123 lamp", description: "Ceramic lamp", brand: "Acme" };
  it("rejects shipping claims in generated copy without AI", async () => {
    expect(await checkGeneratedListingCopy(source, { ...source, description: "Free shipping included" })).toMatch(/shipping claims/);
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("flags strongly conflicting generated copy but does not rewrite it", async () => {
    evaluate.mockResolvedValue({ identityConflict: { type: "boolean", probability: 0.999 }, unsupportedClaims: { type: "boolean", probability: 0 } });
    expect(await checkGeneratedListingCopy(source, source)).toMatch(/original supplier copy was preserved/);
  });
  it("does not block uncertain copy or change fallback behavior on failure", async () => {
    expect(await checkGeneratedListingCopy(source, source)).toBeNull();
    evaluate.mockResolvedValue({ identityConflict: { type: "boolean", probability: 0.8 }, unsupportedClaims: { type: "boolean", probability: 0.8 } });
    expect(await checkGeneratedListingCopy(source, source)).toBeNull();
  });
});
