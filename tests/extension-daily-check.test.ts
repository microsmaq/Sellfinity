import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function scheduler(settings: Record<string, unknown>, active = false) {
  const store = { dailyAdminPriceCheck: settings };
  const opened: unknown[] = [];
  const messages: unknown[] = [];
  const context = {
    chrome: {
      storage: { local: {
        get: async () => store,
        set: async (next: typeof store) => Object.assign(store, next),
      } },
      tabs: {
        create: async (options: unknown) => { opened.push(options); return { id: 42 }; },
        sendMessage: async (_id: number, message: unknown) => { messages.push(message); return { ok: true }; },
      },
      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { create: async () => {}, onAlarm: { addListener() {} } },
    },
    runStatuses: async () => active ? [{ mode: "PRICE", status: "running" }] : [],
    catalogJob: async () => null,
    Date, setTimeout,
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/daily-check.js", "utf8"), context);
  return { store, opened, messages, run: (force = false, resume = false) => runInNewContext(`runDailyCheck(${force}, ${resume})`, context) as Promise<void> };
}

describe("daily admin browser check", () => {
  it("opens user listings and dispatches the user sync task when selected", async () => {
    const check = scheduler({ enabled: true, time: "00:00", mode: "USER" });
    await check.run();
    expect(check.opened).toEqual([{ url: "https://www.sellfinity.app/listings", active: false }]);
    expect(check.messages).toEqual([{ type: "START_DAILY_USER_SYNC", resume: false }]);
  });
  it("does not run when disabled", async () => {
    const check = scheduler({ enabled: false, time: "00:00" });
    await check.run();
    expect(check.opened).toHaveLength(0);
  });
  it("runs a due schedule once per local day", async () => {
    const check = scheduler({ enabled: true, time: "00:00" });
    await check.run();
    await check.run();
    expect(check.opened).toHaveLength(1);
    expect(check.messages).toEqual([{ type: "START_DAILY_ADMIN_CHECK", resume: false }]);
    expect(check.store.dailyAdminPriceCheck.status).toBe("running");
  });
  it("does not overlap an existing price scan", async () => {
    const check = scheduler({ enabled: true, time: "00:00" }, true);
    await check.run(true);
    expect(check.opened).toHaveLength(0);
  });
  it("resumes interrupted checks by skipping saved fresh records", async () => {
    const check = scheduler({ enabled: true, time: "00:00" });
    await check.run(true, true);
    expect(check.messages).toEqual([{ type: "START_DAILY_ADMIN_CHECK", resume: true }]);
  });
});
