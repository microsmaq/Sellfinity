import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInThisContext } from "node:vm";

type PriceResult = { unitPriceCents: number; shippingCents: number | null } | null;
type PriceParser = (document: { querySelectorAll(selector: string): Array<{ textContent: string }> }) => PriceResult;
type AvailabilityParser = (document: {
  querySelectorAll(selector: string): Array<{ textContent: string }>;
  body?: { innerText: string };
  documentElement?: { innerText: string };
  title?: string;
}) => "UNAVAILABLE" | "BLOCKED" | "UNKNOWN";

let parseAmazonPrice: PriceParser;
let parseAmazonAvailability: AvailabilityParser;

beforeAll(() => {
  const source = readFileSync(resolve(process.cwd(), "browser-extension/sellfinity-tracking-helper/amazon-price.js"), "utf8");
  runInThisContext(source);
  parseAmazonPrice = (globalThis as typeof globalThis & { sellfinityAmazonPriceFromPage: PriceParser }).sellfinityAmazonPriceFromPage;
  parseAmazonAvailability = (globalThis as typeof globalThis & { sellfinityAmazonAvailabilityFromPage: AvailabilityParser }).sellfinityAmazonAvailabilityFromPage;
});

function page(price: string, shipping: string) {
  return {
    querySelectorAll(selector: string) {
      if (selector === "#corePrice_feature_div .priceToPay .a-offscreen") return [{ textContent: price }];
      if (selector === "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE") return [{ textContent: shipping }];
      return [];
    },
  };
}

describe("Amazon extension price extraction", () => {
  it("extracts a current price and paid delivery", () => {
    expect(parseAmazonPrice(page("$25.00", "$15.49 delivery Tuesday"))).toEqual({
      unitPriceCents: 2500,
      shippingCents: 1549,
    });
  });

  it("accepts clearly displayed free delivery", () => {
    expect(parseAmazonPrice(page("$12.34", "FREE delivery Tomorrow"))).toEqual({
      unitPriceCents: 1234,
      shippingCents: 0,
    });
  });

  it("preserves existing shipping when Amazon only offers threshold-based free delivery", () => {
    expect(parseAmazonPrice(page("$9.99", "FREE delivery on $35 of items shipped by Amazon"))).toEqual({
      unitPriceCents: 999,
      shippingCents: null,
    });
  });

  it("confirms a product is unavailable only from strong Amazon availability text", () => {
    expect(parseAmazonAvailability({
      querySelectorAll(selector: string) {
        return selector === "#availability" ? [{ textContent: "Currently unavailable. We don't know when or if this item will be back in stock." }] : [];
      },
      body: { innerText: "Product details" },
      title: "Amazon product",
    })).toBe("UNAVAILABLE");
  });

  it("does not mark sign-in or CAPTCHA pages unavailable", () => {
    expect(parseAmazonAvailability({
      querySelectorAll() { return []; },
      body: { innerText: "Enter the characters you see below" },
      title: "Amazon verification",
    })).toBe("BLOCKED");
  });
});
