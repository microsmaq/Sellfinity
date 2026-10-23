import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated Chrome content-script runtime. */
function reader(details: unknown, captureError = false, availability = "UNKNOWN") {
  const sent: any[] = []; const handlers: any[] = [];
  const context: any = {
    document: { readyState: "complete", documentElement: {}, body: { innerText: "Product" } },
    location: { href: "https://www.amazon.com/dp/B012345678" },
    sellfinityAmazonAvailabilityFromPage: () => availability, sellfinityTrackingFromPage: () => null,
    sellfinityAmazonPriceFromPage: () => ({ unitPriceCents: 1299, shippingCents: 399 }),
    sellfinityCaptureCatalogProduct: () => { if (captureError) throw new Error("Unreadable description"); return details; },
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {},
    chrome: { runtime: { sendMessage: async (message: any) => { sent.push(message); return { ok: true }; }, onMessage: { addListener: (handler: any) => handlers.push(handler) } } },
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/amazon-content.js", "utf8"), context);
  handlers[0]({ type: "INSPECT_AMAZON_PRICE" }, {}, () => {});
  return sent;
}
it("captures product content during the existing price inspection without another tab or request", () => {
  const details = { asin: "B012345678", description: "Observed description", images: ["https://m.media-amazon.com/images/I/a.jpg"] };
  expect(reader(details)).toContainEqual({ type: "AMAZON_PRICE_FOUND", unitPriceCents: 1299, shippingCents: 399, productDetails: details });
});
it("retains a usable price result when optional page content is unreadable", () => {
  expect(reader(null, true)).toContainEqual({ type: "AMAZON_PRICE_FOUND", unitPriceCents: 1299, shippingCents: 399, productDetails: null });
});
it("immediately reports confirmed unavailable offers instead of saving the displayed price", () => {
  const sent = reader(null, false, "UNAVAILABLE");
  expect(sent).toContainEqual(expect.objectContaining({ type: "AMAZON_PRICE_NOT_FOUND", unavailable: true, blocked: false }));
  expect(sent.some((message) => message.type === "AMAZON_PRICE_FOUND")).toBe(false);
});
it("loads capture before price inspection and forwards content through both helper bridges", () => {
  const base = "browser-extension/sellfinity-tracking-helper/";
  const manifest = JSON.parse(readFileSync(`${base}manifest.json`, "utf8"));
  const scripts = manifest.content_scripts.find((entry: any) => entry.js.includes("amazon-content.js")).js;
  expect(scripts.indexOf("catalog-capture.js")).toBeLessThan(scripts.indexOf("amazon-content.js"));
  for (const file of ["background.js", "sellfinity-content.js"]) expect(readFileSync(base + file, "utf8")).toContain("productDetails: message.productDetails");
});
