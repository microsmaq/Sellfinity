import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Chrome extension runtime mocks. */
const folder = "browser-extension/sellfinity-tracking-helper/";
const product = { requestKey: "B012345678", amazonUrl: "https://www.amazon.com/dp/B012345678", orderIds: ["row"] };

async function content(sendMessage: () => any) {
  const handlers: Record<string, any> = {};
  const events: any[] = [];
  runInNewContext(readFileSync(folder + "sellfinity-content.js", "utf8"), {
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage } },
    document: {
      addEventListener(name: string, fn: any) { handlers[name] = fn; },
      dispatchEvent(event: any) { events.push(event); },
      getElementById() { return null; },
      createElement() { return { style: {}, remove() {} }; },
      documentElement: { dataset: {}, appendChild() {} },
    },
    CustomEvent: class { constructor(public type: string, public options: any) {} get detail() { return this.options.detail; } },
    setTimeout() {},
  });
  handlers["sellfinity:bulk-amazon-price-check"]({ detail: { requests: [product] } });
  await new Promise((resolve) => setImmediate(resolve));
  return events.map((event) => event.detail);
}

it("catches synchronous invalidated-extension errors with page reload guidance", async () => {
  const events = await content(() => { throw new Error("Extension context invalidated."); });
  expect(events.at(-1)).toMatchObject({ status: "error", error: expect.stringContaining("Reload this Sellfinity page") });
});
it("rejects missing, unsuccessful and empty acknowledgments instead of remaining running", async () => {
  for (const response of [undefined, { ok: false, error: "Storage unavailable" }, { ok: true, queued: 0 }]) {
    expect((await content(async () => response)).at(-1)).toMatchObject({ status: "error", error: expect.any(String) });
  }
});
it("preserves a successful queued response", async () => {
  expect((await content(async () => ({ ok: true, queued: 1 }))).at(-1)).toMatchObject({ status: "running", total: 1 });
});

function worker(initial: any[] = [], storageError = false) {
  let listener: any;
  const data: Record<string, any> = { pendingTrackingRequests: initial };
  const opened: any[] = [];
  const context = {
    URL, crypto: { randomUUID: () => "request" }, importScripts() {}, queueProcessing: false,
    catalogJob: async () => null, reserveAmazonPage: async () => ({ ok: true }), workloadState: async () => ({ paused: false }),
    chrome: {
      runtime: { onMessage: { addListener(fn: any) { listener = fn; } } },
      storage: { local: {
        async get(key: string) { if (storageError) throw new Error("Storage unavailable"); return { [key]: data[key] }; },
        async set(values: any) { Object.assign(data, values); },
      } },
      tabs: {
        onUpdated: { addListener() {} }, onCreated: { addListener() {} }, onRemoved: { addListener() {} },
        async get() { return { id: 1, windowId: 42 }; }, async create(options: any) { opened.push(options); return { id: 9 }; },
        async update() {}, async sendMessage() {},
      },
    },
  };
  runInNewContext(readFileSync(folder + "background.js", "utf8"), context);
  return { data, opened, async send(requests: any[]) {
    const reply = await new Promise<any>((resolve) => listener({ type: "BEGIN_BULK_AMAZON_PRICE_CHECK", requests }, { tab: { id: 1 } }, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return reply;
  } };
}
it("returns a useful response when background storage fails", async () => {
  expect(await worker([], true).send([product])).toMatchObject({ ok: false, error: expect.stringContaining("Storage unavailable") });
});
it("does not acknowledge zero jobs when another tab owns the products", async () => {
  const env = worker([{ ...product, mode: "PRICE", bulk: true, sourceTabId: 2, createdAt: Date.now() }]);
  expect(await env.send([product])).toMatchObject({ ok: false, error: expect.stringContaining("another Sellfinity tab") });
  expect(env.opened).toHaveLength(0);
});
it("deduplicates input and opens the checker in the originating Chrome window", async () => {
  const env = worker();
  expect(await env.send([product, product])).toEqual({ ok: true, queued: 1 });
  expect(env.data.pendingTrackingRequests).toHaveLength(1);
  expect(env.opened).toEqual([{ url: "about:blank", active: false, windowId: 42 }]);
});
it("rejects invalid products without saving a fake running job", async () => {
  const env = worker();
  expect(await env.send([{ ...product, amazonUrl: "https://example.com" }])).toMatchObject({ ok: false });
  expect(env.data.bulkRunStatuses).toBeUndefined();
});
