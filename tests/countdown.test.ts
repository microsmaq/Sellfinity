import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCountdownBestSellers,
  mapCountdownBestSellerResults,
  mapCountdownSearchResults,
} from "@/lib/ebay/countdown";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

describe("Countdown eBay bestseller snapshots", () => {
  it("ranks by reported quantity sold and retains useful seller and landed-price fields", () => {
    const snapshot = mapCountdownBestSellerResults({
      request_info: { success: true, credits_used: 1, credits_remaining: 49 },
      pagination: { total_results: "240" },
      search_results: [
        {
          position: 1,
          title: "Popular Widget",
          link: "https://www.ebay.com/itm/popular-widget/123456789012",
          image: "https://i.ebayimg.com/widget.jpg",
          price: { value: 9.99, currency: "USD" },
          shipping_cost: 2,
          quantity_sold: "800",
          seller_info: { name: "great-store", review_count: 1200, positive_feedback_percent: 99.8 },
        },
        {
          position: 2,
          title: "Top Widget",
          link: "https://www.ebay.com/itm/top-widget/223456789012",
          price: { value: 15, currency: "USD" },
          quantity_sold: 1200,
        },
      ],
    }, "widgets", "2026-08-29T10:00:00.000Z");
    expect(snapshot.items.map((item) => item.itemId)).toEqual(["223456789012", "123456789012"]);
    expect(snapshot.items[1]).toMatchObject({
      quantitySold: 800,
      totalPriceCents: 1199,
      sellerName: "great-store",
      sellerFeedbackPct: 99.8,
    });
    expect(snapshot).toMatchObject({ totalResults: 240, creditsUsed: 1, creditsRemaining: 49 });
  });

  it("deduplicates item IDs and excludes auctions and unusable results", () => {
    const snapshot = mapCountdownBestSellerResults({
      search_results: [
        { title: "Kept", link: "https://www.ebay.com/itm/123456789012", price: { value: 5 }, quantity_sold: 2 },
        { title: "Duplicate", link: "https://www.ebay.com/itm/123456789012", price: { value: 6 }, quantity_sold: 20 },
        { title: "Auction", link: "https://www.ebay.com/itm/223456789012", price: { value: 6 }, is_auction: true },
        { title: "Unreported sales", link: "https://www.ebay.com/itm/323456789012", price: { value: 8 } },
        { title: "Explicit zero", link: "https://www.ebay.com/itm/423456789012", price: { value: 9 }, quantity_sold: 0 },
      ],
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].title).toBe("Kept");
    expect(snapshot.sampledListings).toBe(5);
  });

  it("uses a valid category and steps through supported sizes after free 503 responses", async () => {
    vi.stubEnv("COUNTDOWN_API_KEY", "test-key");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_info: { message: "Request is currently unavailable. You have not been charged for this request." } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        request_info: { success: true, credits_used: 1, credits_remaining: 20 },
        search_results: [],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const snapshot = await fetchCountdownBestSellers("");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    const thirdUrl = new URL(String(fetchMock.mock.calls[2][0]));
    expect(firstUrl.searchParams.get("search_term")).toBe("electronics");
    expect(firstUrl.searchParams.get("num")).toBe("240");
    expect(secondUrl.searchParams.get("num")).toBe("120");
    expect(thirdUrl.searchParams.get("num")).toBe("60");
    expect(snapshot).toMatchObject({ researchTerm: "electronics", requestedResults: 60, fallbackUsed: true });
  });

  it("does not retry a successful Countdown response", async () => {
    vi.stubEnv("COUNTDOWN_API_KEY", "test-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      request_info: { success: true, credits_used: 1 },
      search_results: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const snapshot = await fetchCountdownBestSellers("electronics");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({ researchTerm: "electronics", requestedResults: 240, fallbackUsed: false });
  });
});
