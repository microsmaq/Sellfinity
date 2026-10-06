import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function workload() {
  const state: Record<string, unknown> = {};
  let now = Date.parse("2026-10-06T12:00:00Z");
  let pending: { bulk: boolean; destinationTabId: number | null }[] = [];
  class Clock extends Date { constructor(...args: [] | [number]) { super(args.length ? args[0]! : now); } static now() { return now; } }
  let listener: (message: unknown, sender: unknown, respond: (value: unknown) => void) => void;
  const context = {
    Date: Clock, console,
    pendingRequests: async () => pending, savePending: async () => {},
    catalogJob: async () => null, processCatalogImport: async () => {}, processBulkQueue: async () => {},
    chrome: {
      storage: { local: { get: async () => state, set: async (value: object) => Object.assign(state, value) } },
      runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, onStartup: { addListener: () => {} } },
      alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
      tabs: { sendMessage: async () => {} },
    },
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/workload.js", "utf8"), context);
  return {
    run: (code: string) => runInNewContext(code, context) as Promise<Record<string, unknown>>,
    advance: (ms: number) => { now += ms; },
    activePage: () => { pending = [{ bulk: true, destinationTabId: 42 }]; },
    message: (message: object) => new Promise<Record<string, unknown>>((resolve) => listener(message, {}, (value) => resolve(value as Record<string, unknown>))),
  };
}
describe("Amazon workload controls", () => {
  it("never opens a second helper page while another bulk page is open", async () => {
    const w = workload();
    w.activePage();
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: false, reason: expect.stringContaining("open Amazon page") });
    expect(await w.run("workloadState()")).not.toHaveProperty("used", 1);
  });
  it("enforces page spacing and the daily cap without dropping queued work", async () => {
    const w = workload();
    await w.run("saveWorkload({dailyLimit:2})");
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: true });
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: false });
    w.advance(60_000);
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: true });
    w.advance(60_000);
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: false, reason: expect.stringContaining("Daily page limit") });
    w.advance(24 * 60 * 60_000);
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: true });
  });
  it("takes scheduled breaks between batches", async () => {
    const w = workload();
    await w.run("saveWorkload({batchSize:1, breakMinutes:15})");
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: true });
    w.advance(60_000);
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: false });
    w.advance(14 * 60_000);
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: true });
  });
  it("never automatically clears a verification pause, including on a new day", async () => {
    const w = workload();
    await w.run('pauseAmazonWork("Verification required", true)');
    w.advance(24 * 60 * 60_000);
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: false });
    expect(await w.message({ type: "RESUME_AMAZON_WORK" })).toMatchObject({ ok: false, verificationRequired: true });
    expect(await w.message({ type: "RESUME_AMAZON_WORK", verificationCompleted: true })).toMatchObject({ ok: true });
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: true });
  });
  it("backs off errors and stops after three consecutive failures", async () => {
    const w = workload();
    await w.run("noteAmazonRead(false)");
    expect(await w.run("reserveAmazonPage()")).toMatchObject({ ok: false });
    await w.run("noteAmazonRead(false)");
    await w.run("noteAmazonRead(false)");
    expect(await w.run("workloadState()")).toMatchObject({ paused: true });
  });
  it("does not count confirmed unavailability as a read failure", async () => {
    const w = workload();
    await w.run("noteAmazonRead(false)");
    await w.run("noteAmazonRead(false, true)");
    expect(await w.run("workloadState()")).toMatchObject({ failures: 0 });
  });
  it("validates limits and ignores attempts to change pause state through settings", async () => {
    const w = workload();
    expect(await w.message({ type: "SAVE_WORKLOAD_SETTINGS", settings: { intervalSeconds: 0 } })).toMatchObject({ ok: false });
    await w.run('pauseAmazonWork("Verification", true)');
    expect(await w.message({ type: "SAVE_WORKLOAD_SETTINGS", settings: { intervalSeconds: 120, dailyLimit: 50, batchSize: 10, breakMinutes: 30, paused: false } })).toMatchObject({ ok: true });
    expect(await w.run("workloadState()")).toMatchObject({ paused: true, dailyLimit: 50 });
  });
});
