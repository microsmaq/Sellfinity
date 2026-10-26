import { expect, it, vi } from "vitest";
import { processCatalogApprovalQueue } from "@/lib/arbitrage/catalog-approval-queue";
const item = (id: string, outcome = "review") => ({ id, asin: id, outcome, reason: "Saved decision" });
it("checks 100 snapshot products once, including unchanged review candidates, in small checkpoints", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `id${index}`);
  const review = vi.fn(async (group: string[]) => ({ eligibleIds: group, items: group.map((id) => item(id)) }));
  const result = await processCatalogApprovalQueue(ids, review, { shouldStop: () => false, onProgress: vi.fn() });
  expect(result).toMatchObject({ total: 100, done: 100, review: 100, stopped: false }); expect(review).toHaveBeenCalledTimes(20);
  expect(review.mock.calls.flatMap(([group]) => group)).toEqual(ids);
});
it("has no hidden limit for an all-eligible queue larger than 100", async () => {
  const ids = Array.from({ length: 503 }, (_, index) => `id${index}`);
  const result = await processCatalogApprovalQueue(ids, async (group) => ({ eligibleIds: group, items: group.map((id) => item(id, "published")) }), { shouldStop: () => false, onProgress: vi.fn() });
  expect(result).toMatchObject({ total: 503, done: 503, published: 503 });
});
it("keeps checkpoint items omitted by a server deadline for the next request, without repeating completed ones", async () => {
  const calls: string[][] = [];
  const result = await processCatalogApprovalQueue(["one", "two", "three"], async (group) => { calls.push(group); return { eligibleIds: group, items: [item(group[0])] }; }, { shouldStop: () => false, onProgress: vi.fn() });
  expect(calls).toEqual([["one", "two", "three"], ["two", "three"], ["three"]]); expect(result.done).toBe(3);
});
it("counts items that changed eligibility as skipped and does not retry them", async () => {
  const result = await processCatalogApprovalQueue(["one", "two"], async () => ({ eligibleIds: ["one"], items: [item("one", "published")] }), { shouldStop: () => false, onProgress: vi.fn() });
  expect(result).toMatchObject({ done: 2, published: 1, skipped: 1 });
});
it("stops after the current checkpoint and preserves completed results", async () => {
  let stopped = false;
  const review = vi.fn(async (group: string[]) => { stopped = true; return { eligibleIds: group, items: group.map((id) => item(id)) }; });
  const result = await processCatalogApprovalQueue(["1", "2", "3", "4", "5", "6"], review, { shouldStop: () => stopped, onProgress: vi.fn() });
  expect(result).toMatchObject({ done: 5, total: 6, stopped: true }); expect(review).toHaveBeenCalledTimes(1);
});
it("pauses when another review holds the lease rather than skipping all requested items", async () => {
  const result = await processCatalogApprovalQueue(["one"], async () => ({ skipped: true, reason: "Another review is running" }), { shouldStop: () => false, onProgress: vi.fn() });
  expect(result).toMatchObject({ done: 0, skipped: 0, pauseReason: "Another review is running" });
});
it("does not loop endlessly when an eligible checkpoint reports no progress", async () => {
  const review = vi.fn(async (group: string[]) => ({ eligibleIds: group, items: [] }));
  const result = await processCatalogApprovalQueue(["one"], review, { shouldStop: () => false, onProgress: vi.fn() });
  expect(result.pauseReason).toContain("No progress"); expect(review).toHaveBeenCalledTimes(1);
});
it("pauses on rate limits without marking untouched checkpoint items as reviewed or failed", async () => {
  const review = vi.fn(async (ids: string[]) => ({ eligibleIds: ids, items: [item(ids[0])], pauseReason: "OpenRouter rate limited. Retry after 120 seconds." }));
  const result = await processCatalogApprovalQueue(["one", "two", "three"], review, { shouldStop: () => false, onProgress: vi.fn() });
  expect(result).toMatchObject({ total: 3, done: 1, review: 1, failed: 0, skipped: 0, pauseReason: expect.stringContaining("120 seconds") });
  expect(review).toHaveBeenCalledTimes(1);
});
it("automatically resumes after the delay and retries only unfinished rate-limited items", async () => {
  let now = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const waiting = vi.fn();
    const review = vi.fn().mockResolvedValueOnce({ eligibleIds: ["one", "two", "three"], items: [item("one", "published"), item("two", "waiting")], pauseReason: "Rate limited", retryAfterSeconds: 2, retryIds: ["two"] })
      .mockResolvedValueOnce({ eligibleIds: ["two", "three"], items: [item("two", "published"), item("three")] });
    const result = await processCatalogApprovalQueue(["one", "two", "three"], review, { shouldStop: () => false, onProgress: vi.fn(), onWaiting: waiting, wait: async (ms) => { now += ms; } });
    expect(review.mock.calls).toEqual([[["one", "two", "three"]], [["two", "three"]]]);
    expect(now).toBe(3000);
    expect(result).toMatchObject({ total: 3, done: 3, published: 2, review: 1, failed: 0, skipped: 0 });
    expect(result.items).toHaveLength(3);
    expect(result.items.filter((row) => row.id === "two")).toEqual([item("two", "published")]);
    expect(waiting).toHaveBeenCalledWith({ reason: "Rate limited", remainingSeconds: 2 });
    expect(waiting).toHaveBeenLastCalledWith(null);
  } finally { clock.mockRestore(); }
});
it("stops during the countdown without issuing a resumed request", async () => {
  let now = 0; let stopped = false;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const review = vi.fn().mockResolvedValue({ eligibleIds: ["one"], items: [item("one", "waiting")], pauseReason: "Wait", retryAfterSeconds: 60, retryIds: ["one"] });
    const result = await processCatalogApprovalQueue(["one"], review, { shouldStop: () => stopped, onProgress: vi.fn(), wait: async (ms) => { now += ms; stopped = true; } });
    expect(result).toMatchObject({ done: 0, total: 1, stopped: true, review: 0 });
    expect(review).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});
it("can wait repeatedly without counting a pending item more than once", async () => {
  let now = 0; let calls = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const result = await processCatalogApprovalQueue(["one"], async () => ++calls < 3
      ? { eligibleIds: ["one"], items: [item("one", "waiting")], pauseReason: "Wait", retryAfterSeconds: 1, retryIds: ["one"] }
      : { eligibleIds: ["one"], items: [item("one", "published")] }, { shouldStop: () => false, onProgress: vi.fn(), wait: async (ms) => { now += ms; } });
    expect(calls).toBe(3); expect(now).toBe(2000);
    expect(result).toMatchObject({ done: 1, published: 1, review: 0 }); expect(result.items).toHaveLength(1);
  } finally { clock.mockRestore(); }
});
