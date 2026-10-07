import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Mock the dynamic Chrome worker runtime in a VM. */
it("repairs existing products, records actual visits and counts enriched records without seeking new items", async () => {
  const state: Record<string, any> = {};
  const operations: string[] = [];
  let nextTab = 0;
  const context: any = {
    URL, Date, Set, Promise, setTimeout,
    reserveAmazonPage: async () => ({ ok: true }), runStatuses: async () => [], workloadState: async () => ({}),
    chrome: { storage: { local: { get: async (key: string) => ({ [key]: state[key] }), set: async (value: object) => Object.assign(state, value) } },
      tabs: { create: async () => ({ id: ++nextTab }), get: async () => ({}), remove: async () => {}, sendMessage: async (_id: number, message: any) => {
        if (message.type === "CAPTURE_CATALOG_PRODUCT") return { ok: true, result: { asin: "B012345678", description: "Captured details" } };
        const op = message.payload.operation; operations.push(op);
        return { ok: true, result: op === "repairQueue" ? { candidates: [{ id: "a", asin: "B012345678", amazonUrl: "https://www.amazon.com/dp/B012345678" }] } : op === "save" ? { added: 0, updated: 1, skipped: 0 } : { existing: [] } };
      } }, runtime: { onMessage: { addListener() {} } }, alarms: { onAlarm: { addListener() {} }, create() {} } },
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/catalog-import.js", "utf8"), context);
  await context.beginCatalogImport([], [], 100, null, true);
  for (let step = 0; step < 200 && state.catalogImportJob?.status === "running"; step++) await Promise.resolve();
  expect(state.catalogImportJob).toMatchObject({ status: "complete", cursor: 1, added: 0, updated: 1 });
  expect(operations).toEqual(["filter", "repairQueue", "contentCheck", "save"]);
});
