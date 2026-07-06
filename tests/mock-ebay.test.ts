import { describe, expect, it } from "vitest";
import { ordersForListingDay } from "@/lib/ebay/mock";

const listing = {
  id: "l1",
  ebayListingId: "110123456",
  priceCents: 1899,
  publishedAt: new Date("2026-06-01T00:00:00Z"),
};
const day = Math.floor(new Date("2026-06-10T00:00:00Z").getTime() / 86_400_000);

describe("ordersForListingDay", () => {
  it("is deterministic for the same listing and day", () => {
    expect(ordersForListingDay(listing, day)).toEqual(ordersForListingDay(listing, day));
  });

  it("produces no orders before the listing was published", () => {
    const before = Math.floor(new Date("2026-05-20T00:00:00Z").getTime() / 86_400_000);
    expect(ordersForListingDay(listing, before)).toEqual([]);
  });

  it("produces plausible order volume over a month", () => {
    let total = 0;
    for (let d = day; d < day + 30; d++) {
      const orders = ordersForListingDay(listing, d);
      for (const o of orders) {
        expect(o.salePriceCents).toBe(listing.priceCents);
        expect(o.quantity).toBeGreaterThanOrEqual(1);
        expect(o.ebayListingId).toBe(listing.ebayListingId);
        total += 1;
      }
    }
    // ~0.55/day expected for this price band; allow a generous range.
    expect(total).toBeGreaterThan(5);
    expect(total).toBeLessThan(40);
  });
});
