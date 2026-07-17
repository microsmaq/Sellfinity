import { db } from "@/lib/db";
import type { ListingActivitySource } from "@/lib/mirror/batch-labels";

export type ListingActivityItem = {
  title: string;
  listingId?: string | null;
  ebayListingId?: string | null;
  amazonUrl?: string | null;
  sourcePriceCents?: number | null;
  listingPriceCents?: number | null;
  ok: boolean;
  error?: string | null;
  imageEnhanced?: boolean;
  imageError?: string | null;
};

/** Persist an already-completed listing action in the same durable history as
 * publishing batches. These records never enter the background publisher and
 * do not send a misleading "new listings" completion email. */
export async function recordListingActivity(input: {
  userId: string;
  source: ListingActivitySource;
  items: ListingActivityItem[];
  trigger?: "MANUAL" | "AUTOMATIC";
  improveMainImage?: boolean;
  improveListingContent?: boolean;
}): Promise<string | null> {
  if (input.items.length === 0) return null;
  const now = new Date();
  const succeededCount = input.items.filter((item) => item.ok).length;
  const failedCount = input.items.length - succeededCount;
  const batch = await db.mirrorBatch.create({
    data: {
      userId: input.userId,
      source: input.source,
      trigger: input.trigger ?? "MANUAL",
      improveMainImage: input.improveMainImage ?? false,
      improveListingContent: input.improveListingContent ?? false,
      status: "COMPLETED",
      totalCount: input.items.length,
      succeededCount,
      failedCount,
      emailStatus: "NOT_APPLICABLE",
      startedAt: now,
      completedAt: now,
      items: {
        create: input.items.map((item, position) => ({
          position,
          inputUrl:
            item.amazonUrl ??
            (item.ebayListingId
              ? `https://www.ebay.com/itm/${item.ebayListingId}`
              : `sellfinity://listing/${item.listingId ?? "unknown"}`),
          status: item.ok ? "SUCCEEDED" : "FAILED",
          title: item.title.slice(0, 500),
          sourcePriceCents: item.sourcePriceCents,
          listingPriceCents: item.listingPriceCents,
          listingId: item.listingId,
          ebayListingId: item.ebayListingId,
          error: item.error?.slice(0, 500),
          imageImprovementStatus: input.improveMainImage
            ? item.imageEnhanced
              ? "SUCCEEDED"
              : "FALLBACK"
            : "NOT_REQUESTED",
          imageImprovementError: item.imageError?.slice(0, 500),
          attempts: 1,
          startedAt: now,
          completedAt: now,
        })),
      },
    },
    select: { id: true },
  });
  return batch.id;
}
