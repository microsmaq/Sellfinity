import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated extension popup/service-worker interfaces. */
const folder = "browser-extension/sellfinity-tracking-helper/";

function popup(slow = false) {
  const elements = new Map<string, any>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const events: Record<string, () => void> = {};
  let timerId = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = vi.fn(async (message: any) => {
    if (slow && message.type === "GET_HELPER_STATUS") await gate;
    if (message.type === "GET_HELPER_STATUS") return { ok: true, statuses: [] };
    if (message.type === "GET_WORKLOAD_SETTINGS") return { ok: true, settings: { intervalSeconds: 120, dailyLimit: 50, batchSize: 10, breakMinutes: 20 } };
    if (message.type === "GET_DAILY_SETTINGS") return { ok: true, settings: { enabled: false, time: "02:00", mode: "ADMIN" } };
    return { ok: true, activity: { state: "off", processed: 0, total: 0, errors: [] }, schedule: { enabled: false, pages: ["saved-page"] } };
  });
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { style: {}, value: "", handlers: {}, addEventListener(type: string, fn: any) { this.handlers[type] = fn; } });
    return elements.get(id);
  };
  const context: any = { document: { getElementById: element, querySelectorAll: () => [] }, chrome: { runtime: { getManifest: () => ({ version: "test" }), sendMessage: send } },
    addEventListener(name: string, fn: () => void) { events[name] = fn; },
    setTimeout(fn: () => void, ms: number) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id: number) { timers.delete(id); } };
  runInNewContext(readFileSync(folder + "popup.js", "utf8"), context);
  return { context, element, send, timers, release, close: () => events.pagehide() };
}

it("opens with one compact status pass, no duplicate initialization or work-start messages", async () => {
  const env = popup(); await new Promise((resolve) => setImmediate(resolve));
  expect(env.send.mock.calls.map(([message]) => message.type)).toEqual(["GET_HELPER_STATUS", "GET_WORKLOAD_SETTINGS", "GET_DAILY_SETTINGS", "GET_CATALOG_IMPORT_STATUS"]);
  expect(env.send.mock.calls.at(-1)?.[0]).toEqual({ type: "GET_CATALOG_IMPORT_STATUS", compact: true });
  expect([...env.timers.values()].map((timer) => timer.ms)).toEqual([5000]);
  expect(env.element("work-interval").value).toBe(120);
  expect(env.element("discovery-pages").value).toBe("saved-page");
});
it("does not pile up polling calls while an older computer is still responding", async () => {
  const env = popup(true);
  for (let i = 0; i < 20; i++) await env.context.refreshStatus();
  expect(env.send).toHaveBeenCalledTimes(1); expect(env.timers.size).toBe(0);
  env.release(); await new Promise((resolve) => setImmediate(resolve));
  expect(env.send).toHaveBeenCalledTimes(4); expect(env.timers.size).toBe(1);
});
it("does not overwrite edited settings when refreshing and stops polling when closed", async () => {
  const env = popup(); await new Promise((resolve) => setImmediate(resolve));
  env.element("work-interval").value = "300";
  await env.context.refreshStatus();
  expect(env.element("work-interval").value).toBe("300");
  env.close(); expect(env.timers.size).toBe(0);
  const before = env.send.mock.calls.length;
  await env.context.refreshStatus(); expect(env.send).toHaveBeenCalledTimes(before);
});

it("returns only compact discovery summaries and reads a large saved job once", async () => {
  const state: Record<string, any> = { catalogImportJob: { status: "paused", cursor: 500, candidates: Array(20000).fill({ asin: "B012345678", title: "Saved product ".repeat(50) }), pages: [], errors: Array(100).fill("old error ".repeat(300)) }, catalogDiscoverySchedule: { checksVersion: 1, enabled: false, pages: [], pageChecks: { privateHistory: "saved" } } };
  let listener: any;
  const get = vi.fn(async (key: string) => ({ [key]: state[key] }));
  const set = vi.fn();
  const createTab = vi.fn();
  runInNewContext(readFileSync(folder + "catalog-import.js", "utf8"), {
    URL, Date, setTimeout, localDay: () => "today", workloadState: async () => ({ paused: false, dailyLimit: 100 }),
    chrome: { storage: { local: { get, set } }, tabs: { create: createTab }, runtime: { onMessage: { addListener(fn: any) { listener = fn; } } }, alarms: { onAlarm: { addListener() {} }, create() {} } },
  });
  const reply = await new Promise<any>((resolve) => listener({ type: "GET_CATALOG_IMPORT_STATUS", compact: true }, {}, resolve));
  expect(reply.ok).toBe(true); expect(reply).not.toHaveProperty("job");
  expect(reply.activity).toMatchObject({ processed: 500, total: 20000 });
  expect(reply.activity.errors).toHaveLength(20);
  expect(reply.activity.errors[0].length).toBeLessThanOrEqual(1000);
  expect(reply.schedule).not.toHaveProperty("pageChecks");
  expect(get.mock.calls.filter(([key]) => key === "catalogImportJob")).toHaveLength(1);
  expect(set).not.toHaveBeenCalled(); expect(createTab).not.toHaveBeenCalled();
  expect(state.catalogImportJob.candidates).toHaveLength(20000);
  expect(JSON.stringify(reply).length).toBeLessThan(23000);
  const legacy = await new Promise<any>((resolve) => listener({ type: "GET_CATALOG_IMPORT_STATUS" }, {}, resolve));
  expect(legacy.job).toBe(state.catalogImportJob);
});
