import { describe, expect, it } from "vitest";
import {
  countGloballyNewBestSellers,
  filterUnstoredBestSellerIds,
} from "@/lib/ebay/bestseller-dedupe";

describe("eBay bestseller system-wide deduplication", () => {
  it("counts only item IDs that have never been stored", () => {
    expect(countGloballyNewBestSellers([
      { itemId: "already-stored" },
      { itemId: "new-one" },
      { itemId: "new-one" },
      { itemId: "new-two" },
    ], ["already-stored", "stored-elsewhere"])).toBe(2);
  });

  it("removes stored IDs before requesting eBay item details", () => {
    expect(filterUnstoredBestSellerIds(
      ["stored-one", "new-one", "stored-two", "new-two"],
      ["stored-one", "stored-two"],
    )).toEqual(["new-one", "new-two"]);
  });
});
