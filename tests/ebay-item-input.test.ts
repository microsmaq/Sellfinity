import { describe, expect, it } from "vitest";
import { ebayLegacyItemIdFromInput } from "../src/lib/ebay/item-input";

describe("administrator eBay candidate input", () => {
  it("accepts a numeric item ID", () => {
    expect(ebayLegacyItemIdFromInput(" 318585628983 ")).toBe("318585628983");
  });

  it("extracts item IDs from titled and plain eBay links", () => {
    expect(ebayLegacyItemIdFromInput("https://www.ebay.com/itm/example-product/318585628983")).toBe("318585628983");
    expect(ebayLegacyItemIdFromInput("https://www.ebay.com/itm/318585628983?foo=bar")).toBe("318585628983");
  });

  it("rejects non-eBay and malformed values", () => {
    expect(ebayLegacyItemIdFromInput("https://example.com/itm/318585628983")).toBeNull();
    expect(ebayLegacyItemIdFromInput("not-an-item")).toBeNull();
  });
});
