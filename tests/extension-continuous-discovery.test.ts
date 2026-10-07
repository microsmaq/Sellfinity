import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated Chrome service-worker runtime. */
function runtime(workload: object) {
  const state: Record<string, any> = {};
  let listener: any;
  let opens = 0;
  const context: any = { URL, Date, Math, Set, Promise, setTimeout, localDay: (date: Date) => date.toDateString(),
    workloadState: async () => workload, runStatuses: async () => [], reserveAmazonPage: async () => ({ ok: false, reason: "Slow-drip wait" }),
    chrome: { storage: { local: { get: async (key: string) => ({ [key]: state[key] }), set: async (value: object) => Object.assign(state, value) } }, tabs: { create: async () => ({ id: ++opens }), get: async () => ({}), sendMessage: async () => ({ ok: true, result: { existing: [] } }) }, runtime: { onMessage: { addListener(fn: any) { listener = fn; } } }, alarms: { onAlarm: { addListener() {} }, create() {} } } };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/catalog-import.js", "utf8"), context);
  return { state, context, opens: () => opens, message: (type: string) => new Promise<any>((resolve) => listener({ type }, {}, resolve)) };
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
  checked.state.catalogDiscoverySchedule = { enabled: true, continuous: true, pages: [page], pageVisits: { [page]: Date.now() } };
  await checked.context.continueDiscovery(); expect(checked.opens()).toBe(0);
});
it("Stop disables continuous restarts even when no import is active", async () => {
  const env = runtime({ dailyLimit: 100 }); env.state.catalogDiscoverySchedule = { enabled: true, continuous: true };
  expect(await env.message("STOP_CATALOG_IMPORT")).toMatchObject({ ok: true }); expect(env.state.catalogDiscoverySchedule.enabled).toBe(false);
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
