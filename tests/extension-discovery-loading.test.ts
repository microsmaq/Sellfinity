import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated Chrome worker. */
function runtime(responses: (attempt: number) => object) {
  const state: Record<string, any> = { catalogImportJob: { status: "running", startedAt: 1, adminTabId: 1, candidates: [{ asin: "B012345678", amazonUrl: "https://www.amazon.com/dp/B012345678" }, { asin: "B099999999", amazonUrl: "https://www.amazon.com/dp/B099999999" }], pages: [], pageCursor: 0, cursor: 0, limit: 100, added: 0, updated: 0, skipped: 0, failed: 0, errors: [] } };
  let attempts = 0;
  let pauses = 0;
  const removed: number[] = [];
  const context: any = {
    URL, Date, Set, Promise, setTimeout: (fn: () => void) => { fn(); return 1; },
    reserveAmazonPage: async () => ({ ok: true }), pauseAmazonWork: async () => { pauses++; },
    chrome: { storage: { local: { get: async (key: string) => ({ [key]: state[key] }), set: async (value: object) => Object.assign(state, value) } },
      tabs: { create: async () => ({ id: 2 }), get: async () => ({}), remove: async (id: number) => { removed.push(id); }, sendMessage: async (_id: number, message: any) => message.type === "CATALOG_IMPORT_RPC" ? { ok: true, result: message.payload.operation === "save" ? { added: 1, skipped: 0 } : { existing: [] } } : responses(++attempts) },
      runtime: { onMessage: { addListener() {} } }, alarms: { onAlarm: { addListener() {} }, create() {} } },
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/catalog-import.js", "utf8"), context);
  return { context, state, removed, attempts: () => attempts, pauses: () => pauses };
}
it("waits beyond the old 30-second limit and saves a slow product", async () => {
  const env = runtime((attempt) => attempt <= 45 ? { ok: false, code: "PAGE_LOADING", error: "Product is loading" } : { ok: true, result: { asin: attempt === 46 ? "B012345678" : "B099999999" } });
  await env.context.processCatalogImport();
  expect(env.state.catalogImportJob).toMatchObject({ status: "complete", cursor: 2, added: 2, failed: 0 });
  expect(env.pauses()).toBe(0); expect(env.attempts()).toBe(47);
});
it("continues to the next product after a read timeout without a false verification pause", async () => {
  const env = runtime((attempt) => attempt <= 90 ? { ok: false, error: "Open a complete Amazon product page first. Sign in if required." } : { ok: true, result: { asin: "B099999999" } });
  await env.context.processCatalogImport();
  expect(env.state.catalogImportJob).toMatchObject({ status: "complete", cursor: 2, added: 1, failed: 1 });
  expect(env.state.catalogImportJob.errors[0]).toContain("after 90 seconds");
  expect(env.pauses()).toBe(0); expect(env.removed).toEqual([2, 2]);
});
it("pauses immediately only on an explicit verification signal and keeps the page open", async () => {
  const env = runtime(() => ({ ok: false, blocked: true, code: "VERIFICATION_REQUIRED", error: "Amazon verification required" }));
  await env.context.processCatalogImport();
  expect(env.state.catalogImportJob).toMatchObject({ status: "paused", cursor: 0, failed: 0 });
  expect(env.pauses()).toBe(1); expect(env.attempts()).toBe(1); expect(env.removed).toEqual([]);
});
it("does not treat an empty bestseller page's generic help text as proof of CAPTCHA", async () => {
  const env = runtime(() => ({ ok: false, error: "No ranked bestseller cards were readable. Check Amazon sign-in or CAPTCHA." }));
  await expect(env.context.readCatalogPage("https://www.amazon.com/Best-Sellers/zgbs/kitchen", "CAPTURE_BESTSELLER_PAGE", env.state.catalogImportJob)).rejects.toThrow("after 90 seconds");
  expect(env.pauses()).toBe(0); expect(env.removed).toEqual([2]);
});
