import { beforeEach, describe, expect, it, vi } from "vitest";

const { createBatch } = vi.hoisted(() => ({ createBatch: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { mirrorBatch: { create: createBatch } },
}));

import { recordListingActivity } from "@/lib/listings/activity-history";
import { batchSourceMeta } from "@/lib/mirror/batch-labels";

describe("listing activity history", () => {
  beforeEach(() => {
    createBatch.mockReset();
    createBatch.mockResolvedValue({ id: "activity-1" });
  });

  it("stores a completed one-item AI optimization alongside publishing batches", async () => {
    await expect(
      recordListingActivity({
        userId: "user-1",
        source: "AI_OPTIMIZATION",
        improveMainImage: true,
        improveListingContent: true,
        items: [{
          title: "Optimized product",
          listingId: "listing-1",
          ebayListingId: "123456789",
          amazonUrl: "https://www.amazon.com/dp/B000TEST",
          sourcePriceCents: 1_000,
          listingPriceCents: 1_999,
          ok: true,
          imageEnhanced: true,
        }],
      }),
    ).resolves.toBe("activity-1");

    const data = createBatch.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: "AI_OPTIMIZATION",
      status: "COMPLETED",
      totalCount: 1,
      succeededCount: 1,
      failedCount: 0,
      emailStatus: "NOT_APPLICABLE",
    });
    expect(data.items.create[0]).toMatchObject({
      status: "SUCCEEDED",
      ebayListingId: "123456789",
      imageImprovementStatus: "SUCCEEDED",
    });
  });

  it("labels action records separately from direct publishing", () => {
    expect(batchSourceMeta("LISTING_EDIT")).toEqual({
      label: "Listing edit",
      result: "Updated",
      activity: true,
    });
    expect(batchSourceMeta("ARBITRAGE").activity).toBe(false);
  });
});
