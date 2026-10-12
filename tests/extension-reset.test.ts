import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Mock extension runtime/DOM. */
function runtime(fail = false) {
  let listener: any;
  const events: string[] = [];
  const data: Record<string, unknown> = { pendingTrackingRequests: [1], catalogImportJob: { status: "error" }, catalogDiscoverySchedule: { enabled: true }, dailyAmazonCheck: { enabled: true }, amazonWorkloadControls: { paused: true }, arbitraryOldHistory: [1] };
  const context = { chrome: { runtime: { id: "helper", getURL: (path: string) => `chrome-extension://helper/${path}`, reload: () => events.push("reload"), onMessage: { addListener(fn: any) { listener = fn; } } }, alarms: { clearAll: async () => { events.push("alarms.clearAll"); } }, storage: { local: { clear: async () => { if (fail) throw new Error("Storage unavailable"); for (const key of Object.keys(data)) delete data[key]; events.push("storage.clear"); } } } } };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/reset.js", "utf8"), context);
  return { events, data, send: (sender = { id: "helper", url: "chrome-extension://helper/popup.html" }, confirmed = true) => new Promise<any>((resolve) => listener({ type: "RESET_HELPER", confirmed }, sender, (reply: any) => { events.push("reply"); resolve(reply); })) };
}
it("clears all extension-local state and alarms, then reloads to terminate old tasks", async () => {
  const env = runtime();
  expect(await env.send()).toEqual({ ok: true });
  expect(env.data).toEqual({});
  expect(env.events).toEqual(["alarms.clearAll", "storage.clear", "reply", "reload"]);
});
it("requires explicit confirmation from the popup and rejects content-page requests", async () => {
  for (const sender of [{ id: "other", url: "chrome-extension://helper/popup.html" }, { id: "helper", url: "https://www.sellfinity.app/admin/arbitrage" }, { id: "helper", url: "chrome-extension://helper/popup.html", tab: { id: 1 } }]) {
    const env = runtime(); expect(await env.send(sender)).toMatchObject({ ok: false }); expect(env.events).toEqual(["reply"]); expect(Object.keys(env.data)).toHaveLength(6);
  }
  const env = runtime(); expect(await env.send(undefined, false)).toMatchObject({ ok: false }); expect(env.events).toEqual(["reply"]);
});
it("reports failure without claiming success or reloading when storage cannot be cleared", async () => {
  const env = runtime(true);
  expect(await env.send()).toMatchObject({ ok: false, error: expect.stringContaining("could not complete") });
  expect(env.events).toEqual(["alarms.clearAll", "reply"]); expect(Object.keys(env.data)).toHaveLength(6);
});
it("reset has no browser-tab deletion or cloud/network operations", () => {
  const source = readFileSync("browser-extension/sellfinity-tracking-helper/reset.js", "utf8");
  expect(source).not.toMatch(/fetch\(|chrome\.tabs\.|chrome\.cookies\.|storage\.sync/);
});
function popup(ok = true) {
  const elements = new Map<string, any>();
  const messages: unknown[] = [];
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, open: false, handlers: {} as Record<string, () => Promise<void>>, addEventListener(type: string, fn: () => Promise<void>) { this.handlers[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/popup-reset.js", "utf8"), { document: { getElementById: element }, chrome: { runtime: { sendMessage: async (message: unknown) => { messages.push(message); return ok ? { ok: true } : { ok: false, error: "Storage unavailable" }; } } } });
  return { element, messages };
}
it("opening or cancelling the centered confirmation never resets; confirmation sends exactly one request", async () => {
  const env = popup();
  await env.element("open-reset").handlers.click(); expect(env.element("reset-dialog").open).toBe(true); expect(env.messages).toEqual([]);
  await env.element("cancel-reset").handlers.click(); expect(env.element("reset-dialog").open).toBe(false); expect(env.messages).toEqual([]);
  await env.element("open-reset").handlers.click(); await env.element("confirm-reset").handlers.click();
  expect(env.messages).toEqual([{ type: "RESET_HELPER", confirmed: true }]); expect(env.element("confirm-reset").disabled).toBe(true);
});
it("shows reset failures and allows another attempt", async () => {
  const env = popup(false);
  await env.element("confirm-reset").handlers.click();
  expect(env.element("reset-feedback").textContent).toBe("Storage unavailable"); expect(env.element("confirm-reset").disabled).toBe(false); expect(env.element("cancel-reset").disabled).toBe(false);
});
