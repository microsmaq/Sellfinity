import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic popup DOM mock. */
it("renders discovery progress even when other helper status is unavailable", async () => {
  const elements = new Map<string, any>();
  const context: any = { Date, document: { getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, { textContent: "", style: {}, disabled: false }); return elements.get(id); }, querySelectorAll: () => [] }, chrome: { runtime: { getManifest: () => ({ version: "test" }), sendMessage: async (message: { type: string }) => message.type === "GET_CATALOG_IMPORT_STATUS" ? { activity: { state: "running", reason: "Saving product", processed: 5, total: 10, added: 4, enriched: 0, skipped: 1, failed: 0, pagesChecked: 1, pagesTotal: 1, errors: [], continuous: true, currentAsin: "B012345678" }, job: { status: "running" } } : { ok: false } } } };
  const source = readFileSync("browser-extension/sellfinity-tracking-helper/popup.js", "utf8");
  runInNewContext(source.slice(0, source.indexOf("async function stop(")), context);
  await context.refreshStatus();
  expect(elements.get("catalog-status").textContent).toBe("running");
  expect(elements.get("catalog-detail").textContent).toContain("5/10 products processed");
  expect(elements.get("catalog-bar").style.width).toBe("50%");
  expect(elements.get("catalog-next").textContent).toContain("Continuous discovery enabled");
});
it("shows schedule-wide outcomes and disables Resume for a finished batch", async () => {
  const elements = new Map<string, any>();
  const context: any = { Date, document: { getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, { textContent: "", style: {}, disabled: false }); return elements.get(id); }, querySelectorAll: () => [] }, chrome: { runtime: { sendMessage: async (message: { type: string }) => message.type === "GET_CATALOG_IMPORT_STATUS" ? { activity: { state: "waiting", reason: "Retry cooldown", processed: 0, total: 0, added: 0, enriched: 0, skipped: 0, failed: 1, pagesChecked: 1, pagesTotal: 1, pagesFailed: 1, errors: ["Unreadable category"], enabled: true, continuous: true, categoriesSuccessful: 10, categoriesRetrying: 2, categoriesUnattempted: 8, canResume: false }, job: { status: "complete" } } : { ok: false } } } };
  const source = readFileSync("browser-extension/sellfinity-tracking-helper/popup.js", "utf8");
  context.chrome.runtime.getManifest = () => ({ version: "test" });
  runInNewContext(source.slice(0, source.indexOf("async function stop(")), context);
  await context.refreshStatus();
  expect(elements.get("catalog-next").textContent).toContain("10 successfully read · 2 awaiting retry · 8 not attempted");
  expect(elements.get("resume-catalog").disabled).toBe(true);
  expect(elements.get("resume-catalog").textContent).toBe("No unfinished import to resume");
});
