import { describe, expect, it } from "vitest";
import { mapCountdownSearchResults } from "@/lib/ebay/countdown";

describe("Countdown eBay research mapping", () => {
  it("maps exact live listings and includes buyer-paid shipping in market price", () => {
    const result = mapCountdownSearchResults({
      pagination: { total_results: "120" },
      search_results: [{
        title: "Exact Widget 2 Pack",
        epid: "123456789012",
        link: "https://www.ebay.com/itm/exact-widget/123456789012",
        image: "https://i.ebayimg.com/widget.jpg",
        price: { value: 10, currency: "USD" },
        shipping_cost: 4.99,
        is_auction: false,
      }],
    });
    expect(result.total).toBe(120);
    expect(result.candidates[0]).toMatchObject({
      itemId: "123456789012",
      priceCents: 1499,
      url: "https://www.ebay.com/itm/exact-widget/123456789012",
    });
  });

  it("drops auctions, rewritten suggestions, and unusable results", () => {
    const result = mapCountdownSearchResults({
      search_results: [
        { title: "Auction", epid: "123456789012", link: "https://www.ebay.com/itm/123456789012", price: { value: 5 }, is_auction: true },
        { title: "Loose match", epid: "223456789012", link: "https://www.ebay.com/itm/223456789012", price: { value: 5 }, is_rewritten_result: true },
        { title: "No price", epid: "323456789012", link: "https://www.ebay.com/itm/323456789012" },
      ],
    });
    expect(result.candidates).toEqual([]);
  });
});
