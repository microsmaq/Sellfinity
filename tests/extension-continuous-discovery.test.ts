import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated Chrome service-worker runtime. */
function runtime(workload: object) {
  const state: Record<string, any> = {};
  let listener: any;
  let opens = 0;
  const context: any = { URL, Date, Math, Set, Promise, setTimeout,
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
