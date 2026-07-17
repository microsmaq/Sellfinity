import { describe, expect, it } from "vitest";
import {
  inventoryOfferForListing,
  inventorySkuFromTradingItem,
  parseTradingItem,
} from "@/lib/ebay/real";
import { isAlreadyEndedEbayError } from "@/lib/ebay/errors";
import { findAmazonMatch } from "@/lib/mirror/match";

describe("parseTradingItem", () => {
  const block = `<Item>
    <ItemID>110123456789</ItemID>
    <Title>Handheld Milk Frother &amp; Whisk - 3 Speeds</Title>
    <SellingStatus><CurrentPrice currencyID="USD">12.99</CurrentPrice></SellingStatus>
    <QuantityAvailable>4</QuantityAvailable>
    <PictureDetails><GalleryURL>https://i.ebayimg.com/thumbs/g/abc/s-l140.jpg</GalleryURL></PictureDetails>
    <ListingDetails><StartTime>2026-07-04T12:30:00.000Z</StartTime><ViewItemURL>https://www.ebay.com/itm/110123456789</ViewItemURL></ListingDetails>
  </Item>`;

  it("parses id, title (unescaped), price, quantity, urls", () => {
    const parsed = parseTradingItem(block)!;
    expect(parsed.ebayListingId).toBe("110123456789");
    expect(parsed.title).toBe("Handheld Milk Frother & Whisk - 3 Speeds");
    expect(parsed.priceCents).toBe(1299);
    expect(parsed.quantity).toBe(4);
    expect(parsed.url).toBe("https://www.ebay.com/itm/110123456789");
    expect(parsed.imageUrl).toContain("i.ebayimg.com");
    expect(parsed.listingDate?.toISOString()).toBe("2026-07-04T12:30:00.000Z");
  });

  it("returns null for blocks missing essentials", () => {
    expect(parseTradingItem("<Item><ItemID>1</ItemID></Item>")).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const minimal = `<Item><ItemID>2</ItemID><Title>T is long enough</Title><SellingStatus><CurrentPrice>5.00</CurrentPrice></SellingStatus></Item>`;
    const parsed = parseTradingItem(minimal)!;
    expect(parsed.quantity).toBeNull();
    expect(parsed.imageUrl).toBeNull();
    expect(parsed.url).toBe("https://www.ebay.com/itm/2");
    expect(parsed.listingDate).toBeNull();
  });
});

describe("isAlreadyEndedEbayError", () => {
  it("recognizes stale-list outcomes without swallowing unrelated failures", () => {
    expect(isAlreadyEndedEbayError("This listing has ended.")).toBe(true);
    expect(isAlreadyEndedEbayError("The item has already been ended")).toBe(true);
    expect(isAlreadyEndedEbayError("The listing is not active")).toBe(true);
    expect(isAlreadyEndedEbayError("The auction has already been closed.")).toBe(true);
    expect(isAlreadyEndedEbayError("Authentication token is invalid")).toBe(false);
  });
});

describe("inventoryOfferForListing", () => {
  const offers = [
    { offerId: "wrong-offer", listing: { listingId: "318531475699" } },
    { offerId: "right-offer", listing: { listingId: "198132359011" } },
    { offerId: "draft-offer" },
  ];

  it("selects the offer published as the requested eBay listing", () => {
    expect(inventoryOfferForListing(offers, "198132359011")?.offerId).toBe(
      "right-offer",
    );
  });

  it("does not adopt another listing's offer for the same SKU", () => {
    expect(inventoryOfferForListing(offers, "999999999999")).toBeNull();
  });
});

describe("inventorySkuFromTradingItem", () => {
  it("recovers the original Inventory SKU returned by GetItem", () => {
    expect(
      inventorySkuFromTradingItem(
        "<GetItemResponse><Item><ItemID>123</ItemID><SKU>ORIGINAL&amp;SKU</SKU></Item></GetItemResponse>",
      ),
    ).toBe("ORIGINAL&SKU");
  });

  it("returns null when the listing has no Inventory SKU", () => {
    expect(inventorySkuFromTradingItem("<Item><ItemID>123</ItemID></Item>")).toBeNull();
  });
});

describe("findAmazonMatch (sandbox mode)", () => {
  it("is deterministic per title and returns a plausible match", async () => {
    const a = await findAmazonMatch("Adjustable Dumbbell Set 25lb Pair with Rack");
    const b = await findAmazonMatch("Adjustable Dumbbell Set 25lb Pair with Rack");
    expect(a).toEqual(b);
    if (a) {
      expect(a.asin).toMatch(/^B0[A-Z0-9]{8}$/);
      expect(a.priceCents).toBeGreaterThan(0);
      expect(a.url).toContain(a.asin);
    }
  });
});
