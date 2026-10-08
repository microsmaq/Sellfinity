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
    sellfinityCaptureCatalogProduct: (doc: unknown, url: string) => { asin: string; shippingCents: number | null; availability: string; images: string[]; description: string; bulletPoints: string[] };
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
    expect(() => captureRuntime().sellfinityCaptureCatalogProduct({ title: "Robot Check", body: { innerText: "Enter the characters you see below" } }, "https://www.amazon.com/dp/B012345678")).toThrow("verification");
  });
  it("distinguishes an unfinished bestseller page from a genuine verification block", () => {
    const runtime = captureRuntime();
    const doc = { readyState: "loading", title: "Best Sellers", body: { innerText: "Loading" }, querySelector: () => null, querySelectorAll: () => [] };
    try { runtime.sellfinityCaptureBestsellers(doc, "https://www.amazon.com/Best-Sellers/zgbs/kitchen"); throw new Error("Expected loading error"); }
    catch (error) { expect(error).toMatchObject({ code: "PAGE_LOADING" }); }
    try { runtime.sellfinityCaptureBestsellers({ ...doc, title: "Robot Check" }, "https://www.amazon.com/Best-Sellers/zgbs/kitchen"); throw new Error("Expected verification error"); }
    catch (error) { expect(error).toMatchObject({ code: "VERIFICATION_REQUIRED" }); }
  });
  it("does not label a missing title or empty bestseller page as verification", () => {
    const runtime = captureRuntime();
    const doc = { readyState: "complete", title: "Amazon", body: { innerText: "" }, querySelector: () => null, querySelectorAll: () => [] };
    try { runtime.sellfinityCaptureCatalogProduct(doc, "https://www.amazon.com/dp/B012345678"); throw new Error("Expected missing product"); }
    catch (error) { expect(error).toMatchObject({ code: "PRODUCT_NOT_READABLE" }); }
    try { runtime.sellfinityCaptureBestsellers(doc, "https://www.amazon.com/Best-Sellers/zgbs/kitchen"); throw new Error("Expected missing cards"); }
    catch (error) { expect(error).toMatchObject({ code: "BESTSELLERS_NOT_READABLE" }); }
  });
  it("records ranked cards and deduplicates ASINs", () => {
    const card = { querySelectorAll: () => [{ href: "https://www.amazon.com/dp/B012345678" }], querySelector: () => ({ textContent: "#3" }) };
    const doc = { title: "Home Best Sellers", querySelector: () => ({ textContent: "Home" }), querySelectorAll: () => [card, card] };
    const products = captureRuntime().sellfinityCaptureBestsellers(doc, "https://www.amazon.com/Best-Sellers/zgbs/home-garden");
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ asin: "B012345678", bestsellerRank: 3 });
  });
  it("captures A+ text and deduplicates standard descriptions", () => {
    const doc = { title: "Product", body: { innerText: "Available" }, querySelector: (selector: string) => selector === "input#ASIN" ? { value: "B012345678" } : selector === "#productTitle" ? { textContent: "Test product" } : null,
      querySelectorAll: (selector: string) => selector.includes("#productDescription") ? [{ textContent: "Observed description" }, { textContent: "Observed description. A+ material specifications." }] : [] };
    expect(captureRuntime().sellfinityCaptureCatalogProduct(doc, "https://www.amazon.com/dp/B012345678").description).toBe("Observed description. A+ material specifications.");
  });
  it("uses original-resolution gallery images, deduplicates resizes and rejects unsafe URLs", () => {
    const image = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null });
    const main = image({ "data-a-dynamic-image": JSON.stringify({ "https://m.media-amazon.com/images/I/abc._AC_SX1000_.jpg": [1000, 1000] }), src: "https://m.media-amazon.com/images/I/abc._AC_US40_.jpg" });
    const doc = { title: "Product", body: { innerText: "Available" }, querySelector: (selector: string) => selector === "input#ASIN" ? { value: "B012345678" } : selector === "#productTitle" ? { textContent: "Test product" } : selector.includes("#landingImage") ? main : null,
      querySelectorAll: (selector: string) => selector === "#altImages img" ? [image({ src: "https://m.media-amazon.com/images/I/def._AC_US40_.jpg" }), image({ src: "https://evil.example/image.jpg" }), image({ src: "not a URL" })] : [] };
    expect(captureRuntime().sellfinityCaptureCatalogProduct(doc, "https://www.amazon.com/dp/B012345678").images).toEqual(["https://m.media-amazon.com/images/I/abc.jpg", "https://m.media-amazon.com/images/I/def.jpg"]);
  });
});
