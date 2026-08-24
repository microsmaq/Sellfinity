import { describe, expect, it } from "vitest";
import {
  uniqueBatchIds,
  uniqueInputLines,
} from "../src/lib/mirror/batch-limits";

describe("publishing batch inputs", () => {
  it("keeps every selected Arbitrage Finder item", () => {
    const ids = Array.from({ length: 2_500 }, (_, index) => `item-${index + 1}`);

    expect(uniqueBatchIds(ids)).toHaveLength(2_500);
  });

  it("deduplicates selected IDs without truncating them", () => {
    expect(uniqueBatchIds(["a", "a", "b"])).toEqual(["a", "b"]);
  });

  it("keeps every unique Amazon Mirroring input line", () => {
    const urls = Array.from({ length: 250 }, (_, index) => `https://amazon.com/dp/ITEM${index}`);

    expect(uniqueInputLines([...urls, urls[0]].join("\n"))).toHaveLength(250);
  });
});
