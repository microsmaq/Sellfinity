import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function captureRuntime(price: unknown = { unitPriceCents: 1299, shippingCents: null }) {
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } }, URL,
    sellfinityAmazonPriceFromPage: () => price,
    sellfinityAmazonAvailabilityFromPage: () => "UNKNOWN",
  };
  runInNewContext(readFileSync("browser-extension/sellfinity-tracking-helper/catalog-capture.js", "utf8"), context);
  return context as typeof context & {
    sellfinityCaptureCatalogProduct: (doc: unknown, url: string) => { asin: string; shippingCents: number | null; availability: string };
    sellfinityCaptureBestsellers: (doc: unknown, url: string) => Array<{ asin: string; bestsellerRank: number }>;
  };
}

describe("browser catalog capture", () => {
  it("uses the selected ASIN and preserves unknown shipping", () => {
    const doc = { title: "Product", body: { innerText: "Available product" }, querySelector: (selector: string) => selector === "input#ASIN" ? { value: "B099999999" } : selector === "#productTitle" ? { textContent: "Selected blue variant" } : null, querySelectorAll: () => [] };
    const product = captureRuntime().sellfinityCaptureCatalogProduct(doc, "https://www.amazon.com/dp/B012345678");
    expect(product).toMatchObject({ asin: "B099999999", shippingCents: null, availability: "AVAILABLE" });
  });
  it("never silently accepts a CAPTCHA page", () => {
    expect(() => captureRuntime().sellfinityCaptureCatalogProduct({ title: "Robot Check", body: { innerText: "Enter the characters you see below" } }, "https://www.amazon.com/dp/B012345678")).toThrow("CAPTCHA");
  });
  it("records ranked cards and deduplicates ASINs", () => {
    const card = { querySelectorAll: () => [{ href: "https://www.amazon.com/dp/B012345678" }], querySelector: () => ({ textContent: "#3" }) };
    const doc = { title: "Home Best Sellers", querySelector: () => ({ textContent: "Home" }), querySelectorAll: () => [card, card] };
    const products = captureRuntime().sellfinityCaptureBestsellers(doc, "https://www.amazon.com/Best-Sellers/zgbs/home-garden");
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ asin: "B012345678", bestsellerRank: 3 });
  });
});
