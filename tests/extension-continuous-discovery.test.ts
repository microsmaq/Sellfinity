import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated Chrome service-worker runtime. */
function runtime(workload: object) {
  const state: Record<string, any> = {};
  let listener: any;
  let opens = 0;
  let alarmListener: any;
  const context: any = { URL, Date, Math, Set, Promise, setTimeout, localDay: (date: Date) => date.toDateString(),
    workloadState: async () => workload, runStatuses: async () => [], reserveAmazonPage: async () => ({ ok: false, reason: "Slow-drip wait" }),
    chrome: { storage: { local: { get: async (key: string) => ({ [key]: state[key] }), set: async (value: object) => Object.assign(state, value) } }, tabs: { create: async () => ({ id: ++opens }), get: async () => ({}), sendMessage: async () => ({ ok: true, result: { existing: [] } }) }, runtime: { onMessage: { addListener(fn: any) { listener = fn; } } }, alarms: { onAlarm: { addListener(fn: any) { alarmListener = fn; } }, create() {} } } };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/catalog-import.js", "utf8"), context);
  return { state, context, opens: () => opens, message: (type: string, input = {}) => new Promise<any>((resolve) => listener({ type, ...input }, {}, resolve)), tick: async () => { alarmListener({ name: "catalog-discovery" }); for (let i = 0; i < 100; i++) await Promise.resolve(); } };
}
it("one click supplies categories without changing slow-drip controls or bypassing daily caps", async () => {
  const env = runtime({ used: 100, dailyLimit: 100 });
  expect(await env.message("START_CONTINUOUS_DISCOVERY")).toMatchObject({ ok: true });
  expect(env.state.catalogDiscoverySchedule).toMatchObject({ enabled: true, continuous: true });
  expect(env.state.catalogDiscoverySchedule.pages).toHaveLength(20);
  expect(env.opens()).toBe(0); expect(env.state.amazonWorkloadControls).toBeUndefined();
});
it("respects verification pauses and avoids repeatedly scanning recently visited category pages", async () => {
  const env = runtime({ paused: true, dailyLimit: 100 });
  env.state.catalogDiscoverySchedule = { enabled: true, continuous: true, pages: ["https://www.amazon.com/Best-Sellers/zgbs/kitchen"] };
  await env.context.continueDiscovery(); expect(env.opens()).toBe(0);
  const checked = runtime({ dailyLimit: 100 });
  const page = "https://www.amazon.com/Best-Sellers/zgbs/kitchen";
  checked.state.catalogDiscoverySchedule = { checksVersion: 1, enabled: true, continuous: true, pages: [page], pageChecks: { [page]: { status: "success", successfulAt: Date.now(), attemptedAt: Date.now() } } };
  await checked.context.continueDiscovery(); expect(checked.opens()).toBe(0);
});
it("Stop disables continuous restarts even when no import is active", async () => {
  const env = runtime({ dailyLimit: 100 }); env.state.catalogDiscoverySchedule = { enabled: true, continuous: true };
  expect(await env.message("STOP_CATALOG_IMPORT")).toMatchObject({ ok: true }); expect(env.state.catalogDiscoverySchedule.enabled).toBe(false);
});
it("continuous discovery starts the next category after an unreadable-category batch completes", async () => {
  const env = runtime({ dailyLimit: 100 });
  const bad = "https://www.amazon.com/Best-Sellers/zgbs/arts-crafts?pg=2";
  const next = "https://www.amazon.com/Best-Sellers/zgbs/kitchen";
  env.state.catalogImportJob = { status: "complete", pagesFailed: 1 };
  env.state.catalogDiscoverySchedule = { checksVersion: 1, enabled: true, continuous: true, pages: [bad, next], pageChecks: { [bad]: { status: "failed", attemptedAt: Date.now(), retryAt: Date.now() + 15 * 60_000 } } };
  await env.context.continueDiscovery();
  expect(env.state.catalogImportJob.pages).toEqual([next]);
  expect(env.opens()).toBe(1);
});
it("reports exact daily-cap and verification wait reasons instead of idle", async () => {
  const capped = runtime({ used: 100, dailyLimit: 100 });
  capped.state.catalogDiscoverySchedule = { enabled: true, continuous: true, pages: [] };
  expect(await capped.context.catalogActivity()).toMatchObject({ state: "waiting", reason: expect.stringContaining("Daily page allowance"), nextAt: expect.any(Number) });
  const blocked = runtime({ paused: true, verificationCheckAt: 123, reason: "Complete verification" });
  blocked.state.catalogDiscoverySchedule = { enabled: true, continuous: true };
  expect(await blocked.context.catalogActivity()).toMatchObject({ state: "paused", reason: "Complete verification", nextAt: 123 });
});
it("reports the actual category, ASIN and processed counts while running", async () => {
  const env = runtime({ dailyLimit: 100 });
  env.state.catalogImportJob = { status: "running", stage: "Reading Amazon product details", currentAsin: "B012345678", currentUrl: "https://www.amazon.com/dp/B012345678", productTabId: 2, cursor: 3, candidates: [1,2,3,4,5], added: 2 };
  expect(await env.context.catalogActivity()).toMatchObject({ state: "running", currentAsin: "B012345678", processed: 3, total: 5, added: 2 });
});
it("shows continuous startup failures and does not pretend discovery is running", async () => {
  const env = runtime({ dailyLimit: 100 });
  env.context.runStatuses = async () => [{ status: "running", mode: "PRICE" }];
  expect(await env.message("START_CONTINUOUS_DISCOVERY")).toMatchObject({ ok: false });
  expect((await env.context.catalogActivity()).reason).toContain("price check");
});
it("migrates legacy start timestamps without claiming that unreadable pages succeeded", async () => {
  const env = runtime({ dailyLimit: 100 });
  const page = "https://www.amazon.com/Best-Sellers/zgbs/kitchen";
  env.state.catalogDiscoverySchedule = { enabled: true, continuous: true, pages: [page], pageVisits: { [page]: Date.now() } };
  const settings = await env.context.discoverySettings();
  expect(settings.pageChecks[page]).toMatchObject({ status: "unknown" });
  expect(settings.pageVisits).toBeUndefined();
  expect(env.context.discoveryQueue(settings).map((entry: any) => entry.page)).toEqual([page]);
});
it("prioritizes never-attempted categories over eligible retries and orders attempts oldest first", () => {
  const env = runtime({ dailyLimit: 100 });
  const now = Date.now();
  const settings = { pages: ["retry", "old", "new", "fresh"], pageChecks: {
    retry: { status: "failed", attemptedAt: now - 2000, retryAt: now - 1 },
    old: { status: "failed", attemptedAt: now - 4000, retryAt: now - 1 },
    fresh: { status: "success", attemptedAt: now, successfulAt: now },
  } };
  expect(env.context.discoveryQueue(settings, now).map((entry: any) => entry.page)).toEqual(["new", "old", "retry"]);
});
it("records failure cooldown separately from success and lengthens repeated failures without exceeding four hours", async () => {
  const env = runtime({ dailyLimit: 100 });
  const page = "https://www.amazon.com/Best-Sellers/zgbs/kitchen";
  env.state.catalogDiscoverySchedule = { checksVersion: 1, enabled: true, continuous: true, pages: [page], pageChecks: {} };
  await env.context.recordCategoryCheck(page, "checking");
  await env.context.recordCategoryCheck(page, "failed", "No ranked cards");
  let settings = await env.context.discoverySettings();
  expect(settings.pageChecks[page]).toMatchObject({ status: "failed", failures: 1, lastError: "No ranked cards" });
  expect(settings.pageChecks[page].successfulAt).toBeUndefined();
  expect(settings.pageChecks[page].retryAt - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(env.context.discoveryQueue(settings)).toHaveLength(0);
  expect(await env.context.catalogActivity()).toMatchObject({ reason: expect.stringContaining("cooldown"), categoriesRetrying: 1, categoriesSuccessful: 0 });
  for (let i = 0; i < 8; i++) await env.context.recordCategoryCheck(page, "failed", "Still unreadable");
  settings = await env.context.discoverySettings();
  expect(settings.pageChecks[page].retryAt - Date.now()).toBeLessThanOrEqual(4 * 60 * 60_000);
  await env.context.recordCategoryCheck(page, "success", "", 30);
  settings = await env.context.discoverySettings();
  expect(settings.pageChecks[page]).toMatchObject({ status: "success", failures: 0, retryAt: 0, productsFound: 30 });
  expect(env.context.discoveryQueue(settings)).toHaveLength(0);
});
it("does not record category attempts merely by starting a job while waiting for a workload slot", async () => {
  const env = runtime({ dailyLimit: 100 });
  expect(await env.message("START_CONTINUOUS_DISCOVERY")).toMatchObject({ ok: true });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(env.state.catalogDiscoverySchedule.pageChecks).toEqual({});
  expect(env.state.catalogImportJob).toMatchObject({ status: "paused", pageCursor: 0 });
});
it("does not pretend Resume can restart an exhausted completed batch", async () => {
  const env = runtime({ dailyLimit: 100 });
  env.state.catalogImportJob = { status: "complete", cursor: 0, candidates: [], pageCursor: 1, pages: ["category"] };
  expect(await env.message("RESUME_CATALOG_IMPORT")).toMatchObject({ ok: false, error: expect.stringContaining("batch is finished") });
  expect(env.state.catalogImportJob.status).toBe("complete");
});
it("does not let import Resume override a verification pause", async () => {
  const env = runtime({ dailyLimit: 100, paused: true });
  env.state.catalogImportJob = { status: "error", cursor: 0, candidates: [1], pageCursor: 0, pages: [] };
  expect(await env.message("RESUME_CATALOG_IMPORT")).toMatchObject({ ok: false, error: expect.stringContaining("workload controls") });
  expect(env.state.catalogImportJob.status).toBe("error");
});
it("timed daily discovery retries a failed category that becomes due even after an earlier run today", async () => {
  const env = runtime({ dailyLimit: 100 });
  const page = "https://www.amazon.com/Best-Sellers/zgbs/kitchen";
  env.state.catalogDiscoverySchedule = { checksVersion: 1, enabled: true, continuous: false, time: "00:00", limit: 100, lastDay: new Date().toDateString(), pages: [page], pageChecks: { [page]: { status: "failed", attemptedAt: Date.now() - 900_001, retryAt: Date.now() - 1 } } };
  const batches: any[] = [];
  env.context.beginCatalogImport = async (...args: any[]) => { batches.push(args); };
  await env.tick();
  expect(batches).toHaveLength(1); expect(batches[0][1]).toEqual([page]); expect(batches[0][5]).toBe(true);
});
it("timed daily discovery respects its daily new-product target and shared page cap", async () => {
  const env = runtime({ dailyLimit: 100 });
  env.state.catalogDiscoverySchedule = { checksVersion: 1, enabled: true, time: "00:00", limit: 10, addedDay: new Date().toDateString(), addedToday: 10, pages: ["category"], pageChecks: {} };
  await env.tick(); expect(env.opens()).toBe(0);
  const capped = runtime({ used: 100, dailyLimit: 100 });
  capped.state.catalogDiscoverySchedule = { checksVersion: 1, enabled: true, time: "00:00", limit: 10, pages: ["category"], pageChecks: {} };
  await capped.tick(); expect(capped.opens()).toBe(0);
});
